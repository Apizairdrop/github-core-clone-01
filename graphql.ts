// GraphQL v4: a hand-written parser and executor for the documents the harness
// sends. No schema language, no code generation — the parser turns a document into
// a small AST, and the executor walks it against the store, the same store REST
// and MCP read from, so an object created through one surface is visible through
// the others with the same global id. Unknown repositories read as null (no error);
// an unknown field is an error naming the field, with HTTP 200; a missing or wrong
// Bearer token is a 401. A batched body (a JSON array) answers an array, in order.

import { VIEWER } from './scenario.ts';
import { parseGlobalId, b64encode, b64decode } from './util.ts';
import type { IssueRecord, PullRecord, Repo, Store } from './store.ts';
import type { GitResponse } from './git-http.ts';

// -------------------------------------------------------------------------------------------
// parser: document -> AST
// -------------------------------------------------------------------------------------------

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

export interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Array<{ name: string; value: ValueNode }>;
  selection: SelectionNode[];
}

export interface SpreadNode {
  kind: 'spread';
  name: string;
}

export interface InlineNode {
  kind: 'inline';
  typeCondition: string | null;
  selection: SelectionNode[];
}

export type SelectionNode = FieldNode | SpreadNode | InlineNode;

export interface OperationNode {
  kind: 'query' | 'mutation';
  name: string | null;
  variables: string[];
  selection: SelectionNode[];
}

export interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, { typeCondition: string; selection: SelectionNode[] }>;
}

type Token =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: string };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  while (at < source.length) {
    const char = source[at] as string;
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === ',') {
      at += 1;
      continue;
    }
    if (char === '#') {
      while (at < source.length && source[at] !== '\n') at += 1;
      continue;
    }
    if (char === '.' && source.slice(at, at + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      at += 3;
      continue;
    }
    if ('{}():!$[]=@'.includes(char)) {
      tokens.push({ kind: 'punct', value: char });
      at += 1;
      continue;
    }
    if (char === '"') {
      let value = '';
      at += 1;
      while (at < source.length && source[at] !== '"') {
        if (source[at] === '\\' && at + 1 < source.length) {
          const escaped = source[at + 1] as string;
          value += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped === 'r' ? '\r' : escaped;
          at += 2;
        } else {
          value += source[at] as string;
          at += 1;
        }
      }
      at += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(char)) {
      let value = '';
      while (at < source.length && /[0-9.eE+-]/.test(source[at] as string)) {
        value += source[at] as string;
        at += 1;
      }
      tokens.push({ kind: 'number', value });
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      let value = '';
      while (at < source.length && /[A-Za-z0-9_]/.test(source[at] as string)) {
        value += source[at] as string;
        at += 1;
      }
      tokens.push({ kind: 'name', value });
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(char)} in GraphQL document`);
  }
  return tokens;
}

class Parser {
  #tokens: Token[];
  #at = 0;

  constructor(tokens: Token[]) {
    this.#tokens = tokens;
  }

  #peek(): Token | undefined {
    return this.#tokens[this.#at];
  }

  #next(): Token {
    const token = this.#tokens[this.#at];
    if (token === undefined) throw new Error('unexpected end of GraphQL document');
    this.#at += 1;
    return token;
  }

  #expectPunct(value: string): void {
    const token = this.#next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected ${JSON.stringify(value)} in GraphQL document`);
    }
  }

  #expectName(): string {
    const token = this.#next();
    if (token.kind !== 'name') throw new Error('expected a name in GraphQL document');
    return token.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, { typeCondition: string; selection: SelectionNode[] }>();
    while (this.#peek() !== undefined) {
      const token = this.#peek() as Token;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ kind: 'query', name: null, variables: [], selection: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        this.#next();
        const kind = token.value as 'query' | 'mutation';
        let name: string | null = null;
        const next = this.#peek();
        if (next !== undefined && next.kind === 'name') name = this.#next().value as string;
        const variables: string[] = [];
        const maybeParen = this.#peek();
        if (maybeParen !== undefined && maybeParen.kind === 'punct' && maybeParen.value === '(') {
          this.#next();
          while (true) {
            const inner = this.#peek();
            if (inner === undefined) throw new Error('unterminated variable definitions');
            if (inner.kind === 'punct' && inner.value === ')') {
              this.#next();
              break;
            }
            if (inner.kind === 'punct' && inner.value === '$') {
              this.#next();
              variables.push(this.#expectName());
              this.parseType();
              if (this.#peek()?.kind === 'punct' && (this.#peek() as Token).value === '=') {
                this.#next();
                this.parseValue();
              }
              continue;
            }
            this.#next();
          }
        }
        operations.push({ kind, name, variables, selection: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.#next();
        const name = this.#expectName();
        const on = this.#expectName();
        if (on !== 'on') throw new Error('expected "on" in fragment definition');
        const typeCondition = this.#expectName();
        const selection = this.parseSelectionSet();
        fragments.set(name, { typeCondition, selection });
        continue;
      }
      throw new Error(`unexpected token ${JSON.stringify(token)} in GraphQL document`);
    }
    return { operations, fragments };
  }

  /** Skip a type expression (`String!`, `[Int]`, `CreateIssueInput!`). */
  parseType(): void {
    const token = this.#peek();
    if (token === undefined) return;
    if (token.kind === 'punct' && token.value === '[') {
      this.#next();
      this.parseType();
      this.#expectPunct(']');
    } else if (token.kind === 'name') {
      this.#next();
    }
    if (this.#peek()?.kind === 'punct' && (this.#peek() as Token).value === '!') this.#next();
  }

  parseSelectionSet(): SelectionNode[] {
    this.#expectPunct('{');
    const selections: SelectionNode[] = [];
    while (true) {
      const token = this.#peek();
      if (token === undefined) throw new Error('unterminated selection set');
      if (token.kind === 'punct' && token.value === '}') {
        this.#next();
        break;
      }
      selections.push(this.parseSelection());
    }
    return selections;
  }

  parseSelection(): SelectionNode {
    const token = this.#peek() as Token;
    if (token.kind === 'punct' && token.value === '...') {
      this.#next();
      const next = this.#peek();
      if (next !== undefined && next.kind === 'name' && next.value === 'on') {
        this.#next();
        const typeCondition = this.#expectName();
        return { kind: 'inline', typeCondition, selection: this.parseSelectionSet() };
      }
      if (next !== undefined && next.kind === 'name') {
        return { kind: 'spread', name: this.#next().value as string };
      }
      return { kind: 'inline', typeCondition: null, selection: this.parseSelectionSet() };
    }
    const name = this.#expectName();
    let alias: string | null = null;
    let fieldName = name;
    const colon = this.#peek();
    if (colon !== undefined && colon.kind === 'punct' && colon.value === ':') {
      this.#next();
      alias = name;
      fieldName = this.#expectName();
    }
    const args: Array<{ name: string; value: ValueNode }> = [];
    const maybeParen = this.#peek();
    if (maybeParen !== undefined && maybeParen.kind === 'punct' && maybeParen.value === '(') {
      this.#next();
      while (true) {
        const inner = this.#peek();
        if (inner === undefined) throw new Error('unterminated argument list');
        if (inner.kind === 'punct' && inner.value === ')') {
          this.#next();
          break;
        }
        const argName = this.#expectName();
        this.#expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
    }
    // Directives (@...) are not used by the harness documents; skip them.
    while (this.#peek()?.kind === 'punct' && (this.#peek() as Token).value === '@') {
      this.#next();
      this.#expectName();
      if (this.#peek()?.kind === 'punct' && (this.#peek() as Token).value === '(') {
        this.#next();
        let depth = 1;
        while (depth > 0) {
          const inner = this.#next();
          if (inner.kind === 'punct' && inner.value === '(') depth += 1;
          if (inner.kind === 'punct' && inner.value === ')') depth -= 1;
        }
      }
    }
    let selection: SelectionNode[] = [];
    const brace = this.#peek();
    if (brace !== undefined && brace.kind === 'punct' && brace.value === '{') {
      selection = this.parseSelectionSet();
    }
    return { kind: 'field', name: fieldName, alias, args, selection };
  }

  parseValue(): ValueNode {
    const token = this.#next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.#expectName() };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (true) {
        const inner = this.#peek();
        if (inner === undefined) throw new Error('unterminated list value');
        if (inner.kind === 'punct' && inner.value === ']') {
          this.#next();
          break;
        }
        values.push(this.parseValue());
      }
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (true) {
        const inner = this.#peek();
        if (inner === undefined) throw new Error('unterminated object value');
        if (inner.kind === 'punct' && inner.value === '}') {
          this.#next();
          break;
        }
        const name = this.#expectName();
        this.#expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'number') {
      const value = Number(token.value);
      return token.value.includes('.') || token.value.includes('e') || token.value.includes('E')
        ? { kind: 'float', value }
        : { kind: 'int', value };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${JSON.stringify(token)}`);
  }
}

export function parseGraphQL(source: string): DocumentNode {
  return new Parser(tokenize(source)).parseDocument();
}

/** Resolve a value node against the operation's variables. */
export function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'string':
    case 'enum':
      return node.value;
    case 'int':
    case 'float':
      return node.value;
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.values.map((value) => resolveValue(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

// -------------------------------------------------------------------------------------------
// schema: the fields each type carries, and the enum values
// -------------------------------------------------------------------------------------------

type Source = { __typename: string; [key: string]: unknown };
type Resolver = (source: Source, args: Record<string, unknown>, ctx: ExecCtx) => unknown;

interface ExecCtx {
  store: Store;
  errors: Array<{ message: string }>;
  document: DocumentNode;
  variables: Record<string, unknown>;
}

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

function issueState(issue: IssueRecord): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: PullRecord): string {
  return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function issueSource(repo: Repo, issue: IssueRecord): Source {
  return { __typename: 'Issue', repo, issue };
}

function pullSource(repo: Repo, pull: PullRecord): Source {
  return { __typename: 'PullRequest', repo, pull };
}

function repoSource(repo: Repo): Source {
  return { __typename: 'Repository', repo };
}

function findRepoByDatabaseId(store: Store, databaseId: number): Repo | undefined {
  for (const repo of store.repos.values()) {
    if (repo.databaseId === databaseId) return repo;
  }
  return undefined;
}

/** Resolve a global id to the repo and the issue/pull it names, or null. */
function resolveIssueId(store: Store, id: string): { repo: Repo; issue: IssueRecord } | null {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.kind !== 'Issue') return null;
  const [repoId, number] = parsed.key.split(':').map(Number);
  if (repoId === undefined || number === undefined) return null;
  const repo = findRepoByDatabaseId(store, repoId);
  if (repo === undefined) return null;
  const issue = store.getIssue(repo, number);
  if (issue === undefined) return null;
  return { repo, issue };
}

function resolvePullId(store: Store, id: string): { repo: Repo; pull: PullRecord } | null {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.kind !== 'PullRequest') return null;
  const [repoId, number] = parsed.key.split(':').map(Number);
  if (repoId === undefined || number === undefined) return null;
  const repo = findRepoByDatabaseId(store, repoId);
  if (repo === undefined) return null;
  const pull = store.getPull(repo, number);
  if (pull === undefined) return null;
  return { repo, pull };
}

function resolveRepoId(store: Store, id: string): Repo | null {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.kind !== 'Repository') return null;
  const databaseId = Number(parsed.key);
  if (!Number.isFinite(databaseId)) return null;
  return findRepoByDatabaseId(store, databaseId) ?? null;
}

function encodeCursor(number: number): string {
  return b64encode(`cursor:${number}`);
}

function decodeCursor(cursor: string): number | null {
  try {
    const text = b64decode(cursor);
    const match = /^cursor:(\d+)$/.exec(text);
    return match !== null ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function pageInfoFor<T extends { number: number }>(
  ordered: readonly T[],
  startIndex: number,
  page: readonly T[],
): Source {
  return {
    __typename: 'PageInfo',
    hasNextPage: startIndex + page.length < ordered.length,
    hasPreviousPage: startIndex > 0,
    startCursor: page.length > 0 ? encodeCursor((page[0] as T).number) : null,
    endCursor: page.length > 0 ? encodeCursor((page[page.length - 1] as T).number) : null,
  };
}

function issuesConnection(repo: Repo, args: Record<string, unknown>): Source {
  let list = [...repo.issues];
  const states = args.states as string[] | undefined;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => (state === 'OPEN' ? 'open' : state === 'CLOSED' ? 'closed' : String(state).toLowerCase())));
    list = list.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
  const direction = orderBy?.direction ?? 'ASC';
  list.sort((a, b) => (direction === 'DESC' ? b.number - a.number : a.number - b.number));
  const first = typeof args.first === 'number' ? args.first : list.length;
  const after = typeof args.after === 'string' ? args.after : null;
  let startIndex = 0;
  if (after !== null) {
    const number = decodeCursor(after);
    if (number !== null) {
      const index = list.findIndex((issue) => issue.number === number);
      if (index >= 0) startIndex = index + 1;
    }
  }
  const page = list.slice(startIndex, startIndex + first);
  return {
    __typename: 'IssueConnection',
    nodes: page.map((issue) => issueSource(repo, issue)),
    edges: page.map((issue) => ({ __typename: 'IssueEdge', node: issueSource(repo, issue), cursor: encodeCursor(issue.number) })),
    pageInfo: pageInfoFor(list, startIndex, page),
    totalCount: list.length,
  };
}

function pullsConnection(repo: Repo, args: Record<string, unknown>): Source {
  const list = [...repo.pulls].sort((a, b) => b.number - a.number);
  const first = typeof args.first === 'number' ? args.first : list.length;
  const page = list.slice(0, first);
  return {
    __typename: 'PullRequestConnection',
    nodes: page.map((pull) => pullSource(repo, pull)),
    edges: page.map((pull) => ({ __typename: 'PullRequestEdge', node: pullSource(repo, pull), cursor: encodeCursor(pull.number) })),
    pageInfo: pageInfoFor(list, 0, page),
    totalCount: list.length,
  };
}

// -------------------------------------------------------------------------------------------
// resolvers
// -------------------------------------------------------------------------------------------

const FIELDS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => ({ __typename: 'Viewer' }),
    repository: (_source, args, ctx) => {
      const owner = args.owner as string | undefined;
      const name = args.name as string | undefined;
      if (owner === undefined || name === undefined) return null;
      if (owner !== VIEWER.login) return null;
      const repo = ctx.store.getRepo(owner, name);
      return repo === undefined ? null : repoSource(repo);
    },
    node: (_source, args, ctx) => {
      const id = args.id as string | undefined;
      if (id === undefined) return null;
      const parsed = parseGlobalId(id);
      if (parsed === null) return null;
      if (parsed.kind === 'Repository') {
        const repo = resolveRepoId(ctx.store, id);
        return repo === null ? null : repoSource(repo);
      }
      if (parsed.kind === 'Issue') {
        const found = resolveIssueId(ctx.store, id);
        return found === null ? null : issueSource(found.repo, found.issue);
      }
      if (parsed.kind === 'PullRequest') {
        const found = resolvePullId(ctx.store, id);
        return found === null ? null : pullSource(found.repo, found.pull);
      }
      return null;
    },
    __type: (_source, args) => {
      const name = args.name as string | undefined;
      if (name === undefined) return null;
      if (FIELDS[name] === undefined && ENUM_VALUES[name] === undefined) return null;
      return {
        __typename: '__Type',
        name,
        fields: Object.keys(FIELDS[name] ?? {}),
        enumValues: ENUM_VALUES[name] ?? [],
      };
    },
  },
  Mutation: {
    createIssue: (_source, args, ctx) => {
      const input = args.input as Record<string, unknown> | undefined;
      if (input === undefined) throw new Error('createIssue needs an input');
      const repo = resolveRepoId(ctx.store, String(input.repositoryId ?? ''));
      if (repo === null) throw new Error('createIssue: unknown repository');
      const title = String(input.title ?? '');
      if (title === '') throw new Error('createIssue: title is required');
      const created = ctx.store.createIssue(repo, { title, body: typeof input.body === 'string' ? input.body : '' });
      if ('error' in created) throw new Error(`createIssue: ${created.error}`);
      return { __typename: 'CreateIssuePayload', issue: issueSource(repo, created) };
    },
    closeIssue: (_source, args, ctx) => {
      const input = args.input as Record<string, unknown> | undefined;
      if (input === undefined) throw new Error('closeIssue needs an input');
      const found = resolveIssueId(ctx.store, String(input.issueId ?? ''));
      if (found === null) throw new Error('closeIssue: unknown issue');
      const closed = ctx.store.setIssueState(found.repo, found.issue.number, 'closed');
      if (closed === undefined) throw new Error('closeIssue: unknown issue');
      return { __typename: 'CloseIssuePayload', issue: issueSource(found.repo, closed) };
    },
    createPullRequest: (_source, args, ctx) => {
      const input = args.input as Record<string, unknown> | undefined;
      if (input === undefined) throw new Error('createPullRequest needs an input');
      const repo = resolveRepoId(ctx.store, String(input.repositoryId ?? ''));
      if (repo === null) throw new Error('createPullRequest: unknown repository');
      const created = ctx.store.createPull(repo, {
        head: String(input.headRefName ?? ''),
        base: String(input.baseRefName ?? ''),
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : '',
      });
      if ('error' in created) throw new Error(`createPullRequest: ${created.error}`);
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullSource(repo, created) };
    },
    mergePullRequest: (_source, args, ctx) => {
      const input = args.input as Record<string, unknown> | undefined;
      if (input === undefined) throw new Error('mergePullRequest needs an input');
      const found = resolvePullId(ctx.store, String(input.pullRequestId ?? ''));
      if (found === null) throw new Error('mergePullRequest: unknown pull request');
      const merged = ctx.store.mergePull(found.repo, found.pull.number);
      if ('error' in merged) throw new Error(`mergePullRequest: ${merged.error}`);
      return { __typename: 'MergePullRequestPayload', pullRequest: pullSource(found.repo, merged.pull) };
    },
    addComment: (_source, args, ctx) => {
      const input = args.input as Record<string, unknown> | undefined;
      if (input === undefined) throw new Error('addComment needs an input');
      const found = resolveIssueId(ctx.store, String(input.subjectId ?? ''));
      if (found === null) throw new Error('addComment: unknown subject');
      const body = String(input.body ?? '');
      if (body === '') throw new Error('addComment: body is required');
      const comment = ctx.store.addComment(found.repo, found.issue.number, body);
      if (comment === undefined) throw new Error('addComment: unknown issue');
      return {
        __typename: 'AddCommentPayload',
        commentEdge: {
          __typename: 'IssueCommentEdge',
          node: { __typename: 'IssueComment', comment },
          cursor: encodeCursor(comment.databaseId),
        },
      };
    },
  },
  Viewer: {
    login: () => VIEWER.login,
    id: () => VIEWER.id,
    name: () => VIEWER.name,
    email: () => VIEWER.email,
  },
  User: {
    login: (source) => String(source.login ?? VIEWER.login),
    id: () => VIEWER.id,
    name: () => VIEWER.name,
    email: () => VIEWER.email,
  },
  Repository: {
    id: (source) => (source.repo as Repo).id,
    databaseId: (source) => (source.repo as Repo).databaseId,
    name: (source) => (source.repo as Repo).name,
    nameWithOwner: (source) => `${(source.repo as Repo).owner}/${(source.repo as Repo).name}`,
    owner: (source) => ({ __typename: 'User', login: (source.repo as Repo).owner }),
    defaultBranchRef: (source, _args, ctx) => {
      const repo = source.repo as Repo;
      const tip = ctx.store.branchTip(repo);
      if (tip === null) return null;
      return { __typename: 'Ref', name: repo.defaultBranch, oid: tip };
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    description: (source) => (source.repo as Repo).description,
    private: (source) => (source.repo as Repo).private,
    isPrivate: (source) => (source.repo as Repo).private,
    createdAt: (source) => (source.repo as Repo).createdAt,
    updatedAt: (source) => (source.repo as Repo).updatedAt,
    issue: (source, args, ctx) => {
      const repo = source.repo as Repo;
      const number = args.number as number | undefined;
      if (number === undefined) return null;
      const issue = ctx.store.getIssue(repo, number);
      return issue === undefined ? null : issueSource(repo, issue);
    },
    issues: (source, args) => issuesConnection(source.repo as Repo, args),
    pullRequests: (source, args) => pullsConnection(source.repo as Repo, args),
    pullRequest: (source, args, ctx) => {
      const repo = source.repo as Repo;
      const number = args.number as number | undefined;
      if (number === undefined) return null;
      const pull = ctx.store.getPull(repo, number);
      return pull === undefined ? null : pullSource(repo, pull);
    },
  },
  Ref: {
    name: (source) => String(source.name ?? ''),
    oid: (source) => String(source.oid ?? ''),
  },
  Issue: {
    id: (source) => (source.issue as IssueRecord).id,
    databaseId: (source) => (source.issue as IssueRecord).databaseId,
    number: (source) => (source.issue as IssueRecord).number,
    title: (source) => (source.issue as IssueRecord).title,
    body: (source) => (source.issue as IssueRecord).body,
    state: (source) => issueState(source.issue as IssueRecord),
    createdAt: (source) => (source.issue as IssueRecord).createdAt,
    updatedAt: (source) => (source.issue as IssueRecord).updatedAt,
    author: () => ({ __typename: 'User', login: VIEWER.login }),
  },
  PullRequest: {
    id: (source) => (source.pull as PullRecord).id,
    databaseId: (source) => (source.pull as PullRecord).databaseId,
    number: (source) => (source.pull as PullRecord).number,
    title: (source) => (source.pull as PullRecord).title,
    body: (source) => (source.pull as PullRecord).body,
    state: (source) => pullState(source.pull as PullRecord),
    merged: (source) => (source.pull as PullRecord).merged,
    mergedAt: (source) => (source.pull as PullRecord).mergedAt,
    headRefName: (source) => (source.pull as PullRecord).headRef,
    baseRefName: (source) => (source.pull as PullRecord).baseRef,
    headRefOid: (source, _args, ctx) => {
      const pull = source.pull as PullRecord;
      const repo = source.repo as Repo;
      return ctx.store.branchTip(repo, pull.headRef) ?? pull.headSha;
    },
    baseRefOid: (source) => (source.pull as PullRecord).baseSha,
    mergeable: (source, _args, ctx) => {
      const pull = source.pull as PullRecord;
      const repo = source.repo as Repo;
      if (pull.state !== 'open') return 'UNKNOWN';
      return ctx.store.pullConflicts(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
    },
    createdAt: (source) => (source.pull as PullRecord).createdAt,
    updatedAt: (source) => (source.pull as PullRecord).updatedAt,
    author: () => ({ __typename: 'User', login: VIEWER.login }),
    files: (source, args, ctx) => {
      const pull = source.pull as PullRecord;
      const repo = source.repo as Repo;
      const diffs = ctx.store.pullFiles(repo, pull);
      const first = typeof args.first === 'number' ? args.first : diffs.length;
      const page = diffs.slice(0, first);
      const nodes = page.map((file) => ({
        __typename: 'PullRequestFile',
        path: file.path,
        additions: file.additions,
        deletions: file.deletions,
        changeType: file.status === 'removed' ? 'DELETED' : file.status === 'added' ? 'ADDED' : 'MODIFIED',
      }));
      return {
        __typename: 'PullRequestFileConnection',
        nodes,
        edges: nodes.map((node) => ({ __typename: 'PullRequestFileEdge', node, cursor: encodeCursor(0) })),
        pageInfo: { __typename: 'PageInfo', hasNextPage: page.length < diffs.length, hasPreviousPage: false, startCursor: null, endCursor: null },
        totalCount: diffs.length,
      };
    },
  },
  PullRequestFile: {
    path: (source) => String(source.path ?? ''),
    additions: (source) => Number(source.additions ?? 0),
    deletions: (source) => Number(source.deletions ?? 0),
    changeType: (source) => String(source.changeType ?? 'MODIFIED'),
  },
  IssueConnection: {
    nodes: (source) => (source.nodes as Source[]) ?? [],
    edges: (source) => (source.edges as Source[]) ?? [],
    pageInfo: (source) => source.pageInfo as Source,
    totalCount: (source) => Number(source.totalCount ?? 0),
  },
  PullRequestConnection: {
    nodes: (source) => (source.nodes as Source[]) ?? [],
    edges: (source) => (source.edges as Source[]) ?? [],
    pageInfo: (source) => source.pageInfo as Source,
    totalCount: (source) => Number(source.totalCount ?? 0),
  },
  PullRequestFileConnection: {
    nodes: (source) => (source.nodes as Source[]) ?? [],
    edges: (source) => (source.edges as Source[]) ?? [],
    pageInfo: (source) => source.pageInfo as Source,
    totalCount: (source) => Number(source.totalCount ?? 0),
  },
  IssueEdge: {
    node: (source) => source.node as Source,
    cursor: (source) => String(source.cursor ?? ''),
  },
  PullRequestEdge: {
    node: (source) => source.node as Source,
    cursor: (source) => String(source.cursor ?? ''),
  },
  PullRequestFileEdge: {
    node: (source) => source.node as Source,
    cursor: (source) => String(source.cursor ?? ''),
  },
  PageInfo: {
    hasNextPage: (source) => Boolean(source.hasNextPage),
    hasPreviousPage: (source) => Boolean(source.hasPreviousPage),
    startCursor: (source) => (source.startCursor as string | null) ?? null,
    endCursor: (source) => (source.endCursor as string | null) ?? null,
  },
  IssueComment: {
    id: (source) => (source.comment as { id: string }).id,
    databaseId: (source) => (source.comment as { databaseId: number }).databaseId,
    body: (source) => (source.comment as { body: string }).body,
    createdAt: (source) => (source.comment as { createdAt: string }).createdAt,
    author: () => ({ __typename: 'User', login: VIEWER.login }),
  },
  IssueCommentEdge: {
    node: (source) => source.node as Source,
    cursor: (source) => String(source.cursor ?? ''),
  },
  CreateIssuePayload: {
    issue: (source) => source.issue as Source,
  },
  CloseIssuePayload: {
    issue: (source) => source.issue as Source,
  },
  CreatePullRequestPayload: {
    pullRequest: (source) => source.pullRequest as Source,
  },
  MergePullRequestPayload: {
    pullRequest: (source) => source.pullRequest as Source,
  },
  AddCommentPayload: {
    commentEdge: (source) => source.commentEdge as Source,
  },
  __Type: {
    name: (source) => String(source.name ?? ''),
    fields: (source) => {
      const names = source.fields as string[];
      return names.map((name) => ({ __typename: '__Field', name }));
    },
    enumValues: (source) => {
      const names = source.enumValues as string[];
      return names.map((name) => ({ __typename: '__EnumValue', name }));
    },
  },
  __Field: {
    name: (source) => String(source.name ?? ''),
  },
  __EnumValue: {
    name: (source) => String(source.name ?? ''),
  },
};

// -------------------------------------------------------------------------------------------
// executor
// -------------------------------------------------------------------------------------------

function resolveField(typename: string, source: Source, field: FieldNode, ctx: ExecCtx): unknown {
  const resolvers = FIELDS[typename];
  const resolver = resolvers?.[field.name];
  if (resolver === undefined) {
    ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typename}".` });
    return undefined;
  }
  const args: Record<string, unknown> = {};
  for (const arg of field.args) args[arg.name] = resolveValue(arg.value, ctx.variables);
  try {
    return resolver(source, args, ctx);
  } catch (err) {
    ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
    return undefined;
  }
}

function executeSelection(typename: string, source: Source, selection: SelectionNode[], ctx: ExecCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const node of selection) {
    if (node.kind === 'inline') {
      if (node.typeCondition === null || node.typeCondition === typename) {
        Object.assign(out, executeSelection(typename, source, node.selection, ctx));
      }
      continue;
    }
    if (node.kind === 'spread') {
      const fragment = ctx.document.fragments.get(node.name);
      if (fragment !== undefined && fragment.typeCondition === typename) {
        Object.assign(out, executeSelection(typename, source, fragment.selection, ctx));
      }
      continue;
    }
    const key = node.alias ?? node.name;
    const value = resolveField(typename, source, node, ctx);
    if (value === undefined || value === null) {
      out[key] = null;
      continue;
    }
    if (node.selection.length === 0) {
      out[key] = value;
      continue;
    }
    if (Array.isArray(value)) {
      out[key] = value.map((item) => {
        if (item !== null && typeof item === 'object' && '__typename' in (item as Record<string, unknown>)) {
          const typed = item as Source;
          return executeSelection(typed.__typename, typed, node.selection, ctx);
        }
        return item;
      });
      continue;
    }
    if (typeof value === 'object' && '__typename' in (value as Record<string, unknown>)) {
      const typed = value as Source;
      out[key] = executeSelection(typed.__typename, typed, node.selection, ctx);
      continue;
    }
    out[key] = value;
  }
  return out;
}

function executeOperation(
  store: Store,
  operation: OperationNode,
  variables: Record<string, unknown>,
  document: DocumentNode,
): Record<string, unknown> {
  const ctx: ExecCtx = { store, errors: [], document, variables };
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelection(rootType, { __typename: rootType }, operation.selection, ctx);
  const response: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) response.errors = ctx.errors;
  return response;
}

// -------------------------------------------------------------------------------------------
// handler
// -------------------------------------------------------------------------------------------

/**
 * Route a GraphQL request. Returns null when the path is not /api/graphql, so the
 * caller can try the other surfaces. A batched body (a JSON array) answers an array
 * of responses, in order.
 */
export function handleGraphQL(
  store: Store,
  token: string,
  method: string,
  pathname: string,
  headers: Headers,
  body: Buffer,
): GitResponse | null {
  if (pathname !== '/api/graphql') return null;
  if (method !== 'POST') {
    return { status: 405, contentType: 'application/json', body: Buffer.from(JSON.stringify({ errors: [{ message: 'Method Not Allowed' }] })) };
  }
  if (token !== '') {
    const presented = headers.get('authorization') ?? '';
    if (presented !== `Bearer ${token}`) {
      return { status: 401, contentType: 'application/json', body: Buffer.from(JSON.stringify({ errors: [{ message: 'Bad credentials' }] })) };
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ errors: [{ message: 'Invalid JSON body' }] })) };
  }
  const requests = Array.isArray(parsed) ? parsed : [parsed];
  const responses: unknown[] = [];
  for (const request of requests) {
    if (request === null || typeof request !== 'object' || typeof (request as Record<string, unknown>).query !== 'string') {
      responses.push({ errors: [{ message: 'A query is required' }] });
      continue;
    }
    const query = (request as Record<string, unknown>).query as string;
    const variables = ((request as Record<string, unknown>).variables ?? {}) as Record<string, unknown>;
    let document: DocumentNode;
    try {
      document = parseGraphQL(query);
    } catch (err) {
      responses.push({ errors: [{ message: err instanceof Error ? err.message : 'GraphQL syntax error' }] });
      continue;
    }
    if (document.operations.length === 0) {
      responses.push({ errors: [{ message: 'No operation in document' }] });
      continue;
    }
    const operation = document.operations[0] as OperationNode;
    responses.push(executeOperation(store, operation, variables, document));
  }
  const payload = Array.isArray(parsed) ? responses : responses[0];
  return { status: 200, contentType: 'application/json', body: Buffer.from(JSON.stringify(payload)) };
}
