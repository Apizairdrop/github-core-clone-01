// The forge's in-memory store: one process, no disk, no network.
//
// A repository holds its refs, issues, pull requests and labels; all git objects live
// in one content-addressed map (an object's id is its content hash, so sharing the map
// across repositories is safe — reachability is always computed from a repo's refs).
// Everything is deterministic: timestamps come from the trial's fixed now, ids from
// counters, so a live run and its replay build the same state.

import {
  buildCommit,
  buildTag,
  buildTreeFromFiles,
  collectReachable,
  diffTrees,
  flattenTree,
  hashObject,
  listDir,
  parseCommit,
  parseTag,
  parseTree,
  readPath,
  ZERO_OID,
  type FileDiff,
  type GitObject,
  type GitObjectType,
} from './git-objects.ts';
import { DEFAULT_BRANCH, VIEWER } from './scenario.ts';
import { globalId, isSha40, trialIso, trialNowSec } from './util.ts';

export interface CommentRecord {
  id: string;
  databaseId: number;
  body: string;
  createdAt: string;
}

export interface IssueRecord {
  id: string;
  databaseId: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRecord[];
  createdAt: string;
  updatedAt: string;
}

export interface PullRecord {
  id: string;
  databaseId: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  createdAt: string;
  updatedAt: string;
}

export interface LabelRecord {
  id: string;
  databaseId: number;
  name: string;
  color: string;
}

export interface Repo {
  id: string;
  databaseId: number;
  name: string;
  owner: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  refs: Map<string, string>;
  issues: IssueRecord[];
  pulls: PullRecord[];
  labels: LabelRecord[];
  nextNumber: number;
  nextCommentId: number;
  nextLabelId: number;
}

/** The identity line of a commit or tag the forge writes itself. */
function identityLine(): string {
  return `${VIEWER.name} <${VIEWER.email}> ${trialNowSec()} +0000`;
}

/** A repo's JSON view, the shape REST and GraphQL both read from. */
export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    databaseId: repo.databaseId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1000, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
  };
}

export function issueJson(repo: Repo, issue: IssueRecord): Record<string, unknown> {
  return {
    id: issue.id,
    databaseId: issue.databaseId,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.find((candidate) => candidate.name === name);
      return { id: label?.databaseId ?? 0, name, color: label?.color ?? 'ededed', description: '' };
    }),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

export function commentJson(comment: CommentRecord): Record<string, unknown> {
  // REST ids are numbers; the opaque global id rides as node_id, as GitHub does.
  return { id: comment.databaseId, node_id: comment.id, databaseId: comment.databaseId, body: comment.body, created_at: comment.createdAt };
}

export function labelJson(label: LabelRecord): Record<string, unknown> {
  return { id: label.id, databaseId: label.databaseId, name: label.name, color: label.color, description: '' };
}

export function pullJson(repo: Repo, pull: PullRecord, store: Store): Record<string, unknown> {
  const headSha = store.branchTip(repo, pull.headRef) ?? pull.headSha;
  return {
    id: pull.id,
    databaseId: pull.databaseId,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
  };
}

export class Store {
  objects = new Map<string, GitObject>();
  repos = new Map<string, Repo>();
  #nextRepoId = 1;
  #nextIssueDbId = 1;
  #nextPullDbId = 1;

  lookup = (oid: string): GitObject | undefined => this.objects.get(oid);

  // -------------------------------------------------------------------------------------------
  // git objects
  // -------------------------------------------------------------------------------------------

  /** Store an object, returning its id (an existing identical object is a no-op). */
  putObject(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  /** Whether `ancestor` is reachable from `descendant` (or the two are equal). */
  isAncestor(ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    if (ancestor === ZERO_OID) return true;
    const seen = new Set<string>();
    const stack = [descendant];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (oid === ancestor) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = this.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) stack.push(parent);
    }
    return false;
  }

  /** Peel a tag (recursively) to the commit it names, or the oid itself. */
  peelToCommit(oid: string): string {
    let current = oid;
    for (let depth = 0; depth < 10; depth += 1) {
      const object = this.objects.get(current);
      if (object === undefined || object.type !== 'tag') return current;
      current = parseTag(object.data).object;
    }
    return current;
  }

  /** The objects reachable from `roots`, as a map (for pack building). */
  reachableObjects(roots: readonly string[]): Map<string, GitObject> {
    const ids = collectReachable(roots, this.lookup);
    const out = new Map<string, GitObject>();
    for (const oid of ids) {
      const object = this.objects.get(oid);
      if (object !== undefined) out.set(oid, object);
    }
    return out;
  }

  // -------------------------------------------------------------------------------------------
  // repositories
  // -------------------------------------------------------------------------------------------

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(owner: string, name: string, options: { private?: boolean; description?: string }): Repo | null {
    if (this.repos.has(this.repoKey(owner, name))) return null;
    const databaseId = this.#nextRepoId;
    this.#nextRepoId += 1;
    const now = trialIso();
    const repo: Repo = {
      id: globalId('Repository', String(databaseId)),
      databaseId,
      name,
      owner,
      private: options.private ?? true,
      description: options.description ?? '',
      defaultBranch: DEFAULT_BRANCH,
      createdAt: now,
      updatedAt: now,
      refs: new Map(),
      issues: [],
      pulls: [],
      labels: [],
      nextNumber: 1,
      nextCommentId: 1,
      nextLabelId: 1,
    };
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  /** The viewer's repositories, in creation order. */
  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === owner) out.push(repo);
    }
    return out;
  }

  /** Resolve a ref name or a commit id to a commit id, or null. */
  resolveRef(repo: Repo, ref: string): string | null {
    if (isSha40(ref)) {
      const object = this.objects.get(ref);
      if (object !== undefined && (object.type === 'commit' || object.type === 'tag')) {
        return this.peelToCommit(ref);
      }
      return null;
    }
    const direct = repo.refs.get(ref);
    if (direct !== undefined) return this.peelToCommit(direct);
    const branch = repo.refs.get(`refs/heads/${ref}`);
    if (branch !== undefined) return this.peelToCommit(branch);
    const tag = repo.refs.get(`refs/tags/${ref}`);
    if (tag !== undefined) return this.peelToCommit(tag);
    return null;
  }

  /** The tip commit of a branch (its name, or the default branch), or null. */
  branchTip(repo: Repo, branch?: string): string | null {
    const name = branch ?? repo.defaultBranch;
    const ref = repo.refs.get(`refs/heads/${name}`);
    if (ref === undefined) return null;
    return this.peelToCommit(ref);
  }

  /** Create a commit object and store it, returning its id. */
  createCommit(fields: { tree: string; parents: readonly string[]; message: string }): string {
    const data = buildCommit({
      tree: fields.tree,
      parents: fields.parents,
      author: identityLine(),
      committer: identityLine(),
      message: fields.message,
    });
    return this.putObject('commit', data);
  }

  /** Create an annotated tag object and store it, returning its id. */
  createTag(fields: { object: string; type: string; tag: string; message: string }): string {
    const data = buildTag({
      object: fields.object,
      type: fields.type,
      tag: fields.tag,
      tagger: identityLine(),
      message: fields.message,
    });
    return this.putObject('tag', data);
  }

  // -------------------------------------------------------------------------------------------
  // contents: files on a branch, through git objects
  // -------------------------------------------------------------------------------------------

  /**
   * Write one file on a branch, making a commit. Returns the commit and blob ids, or
   * an error when the branch does not exist (and the repo is not empty) or the sha check fails.
   * `expectedSha` is the blob id the caller believes is current; a mismatch is a 409.
   */
  putContent(
    repo: Repo,
    options: { path: string; content: Buffer; message: string; branch?: string; expectedSha?: string },
  ): { commitSha: string; contentSha: string } | { error: 'not-found' | 'stale-sha' } {
    const branch = options.branch ?? repo.defaultBranch;
    const tip = this.branchTip(repo, branch);
    const isFirst = tip === null && repo.refs.size === 0 && branch === repo.defaultBranch;
    if (tip === null && !isFirst) return { error: 'not-found' };
    const baseFiles = new Map<string, string>();
    if (tip !== null) {
      const commit = this.objects.get(tip);
      if (commit !== undefined && commit.type === 'commit') {
        const flat = flattenTree(parseCommit(commit.data).tree, this.lookup);
        for (const [path, entry] of flat) baseFiles.set(path, entry.oid);
      }
    }
    if (options.expectedSha !== undefined) {
      const current = baseFiles.get(options.path);
      if (current === undefined || current.toLowerCase() !== options.expectedSha.toLowerCase()) {
        return { error: 'stale-sha' };
      }
    }
    const blobOid = this.putObject('blob', options.content);
    const files = new Map(baseFiles);
    files.set(options.path, blobOid);
    const treeOid = buildTreeFromFiles(files, (type, data) => this.putObject(type, data));
    const parents = tip === null ? [] : [tip];
    const commitSha = this.createCommit({ tree: treeOid, parents, message: options.message });
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    repo.updatedAt = trialIso();
    return { commitSha, contentSha: blobOid };
  }

  /** Read one file at a ref (branch name or commit id). */
  getContent(
    repo: Repo,
    path: string,
    ref?: string,
  ): { oid: string; data: Buffer } | { error: 'not-found' } {
    const commitOid = ref === undefined ? this.branchTip(repo) : this.resolveRef(repo, ref);
    if (commitOid === null) return { error: 'not-found' };
    const found = readPath(commitOid, path, this.lookup);
    if (found === null) return { error: 'not-found' };
    return found;
  }

  /** List the entries directly under a directory at a ref. */
  listContentDir(repo: Repo, dirPath: string, ref?: string): Array<{ name: string; path: string; oid: string; mode: string }> | null {
    const commitOid = ref === undefined ? this.branchTip(repo) : this.resolveRef(repo, ref);
    if (commitOid === null) return null;
    return listDir(commitOid, dirPath, this.lookup);
  }

  /** Delete one file on a branch, making a commit. */
  deleteContent(
    repo: Repo,
    options: { path: string; message: string; branch?: string; expectedSha?: string },
  ): { commitSha: string } | { error: 'not-found' | 'stale-sha' } {
    const branch = options.branch ?? repo.defaultBranch;
    const tip = this.branchTip(repo, branch);
    if (tip === null) return { error: 'not-found' };
    const commit = this.objects.get(tip);
    if (commit === undefined || commit.type !== 'commit') return { error: 'not-found' };
    const flat = flattenTree(parseCommit(commit.data).tree, this.lookup);
    const current = flat.get(options.path);
    if (current === undefined) return { error: 'not-found' };
    if (options.expectedSha !== undefined && current.oid.toLowerCase() !== options.expectedSha.toLowerCase()) {
      return { error: 'stale-sha' };
    }
    const files = new Map<string, string>();
    for (const [path, entry] of flat) {
      if (path !== options.path) files.set(path, entry.oid);
    }
    const treeOid = buildTreeFromFiles(files, (type, data) => this.putObject(type, data));
    const commitSha = this.createCommit({ tree: treeOid, parents: [tip], message: options.message });
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    repo.updatedAt = trialIso();
    return { commitSha };
  }

  /** The commit history of a ref, newest first, with messages. */
  listCommits(repo: Repo, ref?: string): Array<{ sha: string; message: string }> {
    const tip = ref === undefined ? this.branchTip(repo) : this.resolveRef(repo, ref);
    if (tip === null) return [];
    const out: Array<{ sha: string; message: string }> = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = this.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      const view = parseCommit(object.data);
      out.push({ sha: oid, message: view.message.replace(/\n+$/, '') });
      for (let i = view.parents.length - 1; i >= 0; i -= 1) stack.push(view.parents[i] as string);
    }
    return out;
  }

  // -------------------------------------------------------------------------------------------
  // issues, labels, comments
  // -------------------------------------------------------------------------------------------

  createLabel(repo: Repo, name: string, color: string): LabelRecord {
    const existing = repo.labels.find((label) => label.name === name);
    if (existing !== undefined) return existing;
    const databaseId = repo.nextLabelId;
    repo.nextLabelId += 1;
    const label: LabelRecord = {
      id: globalId('Label', `${repo.databaseId}:${databaseId}`),
      databaseId,
      name,
      color: color === '' ? 'ededed' : color,
    };
    repo.labels.push(label);
    return label;
  }

  findLabel(repo: Repo, name: string): LabelRecord | undefined {
    return repo.labels.find((label) => label.name === name);
  }

  createIssue(
    repo: Repo,
    input: { title: string; body?: string; labels?: string[] },
  ): IssueRecord | { error: 'bad-label'; label: string } {
    const names = input.labels ?? [];
    for (const name of names) {
      if (this.findLabel(repo, name) === undefined) return { error: 'bad-label', label: name };
    }
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const databaseId = this.#nextIssueDbId;
    this.#nextIssueDbId += 1;
    const now = trialIso();
    const issue: IssueRecord = {
      id: globalId('Issue', `${repo.databaseId}:${number}`),
      databaseId,
      number,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      labels: [...names],
      comments: [],
      createdAt: now,
      updatedAt: now,
    };
    repo.issues.push(issue);
    return issue;
  }

  getIssue(repo: Repo, number: number): IssueRecord | undefined {
    return repo.issues.find((issue) => issue.number === number);
  }

  listIssues(repo: Repo, options: { state?: string; direction?: string }): IssueRecord[] {
    let list = [...repo.issues];
    const state = options.state ?? 'open';
    if (state !== 'all') list = list.filter((issue) => issue.state === state);
    const direction = options.direction ?? 'desc';
    list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
    return list;
  }

  setIssueState(repo: Repo, number: number, state: 'open' | 'closed'): IssueRecord | undefined {
    const issue = this.getIssue(repo, number);
    if (issue === undefined) return undefined;
    issue.state = state;
    issue.updatedAt = trialIso();
    return issue;
  }

  addComment(repo: Repo, number: number, body: string): CommentRecord | undefined {
    const issue = this.getIssue(repo, number);
    if (issue === undefined) return undefined;
    const databaseId = repo.nextCommentId;
    repo.nextCommentId += 1;
    const comment: CommentRecord = {
      id: globalId('IssueComment', `${repo.databaseId}:${number}:${databaseId}`),
      databaseId,
      body,
      createdAt: trialIso(),
    };
    issue.comments.push(comment);
    issue.updatedAt = trialIso();
    return comment;
  }

  // -------------------------------------------------------------------------------------------
  // pull requests
  // -------------------------------------------------------------------------------------------

  createPull(
    repo: Repo,
    input: { head: string; base: string; title: string; body?: string },
  ): PullRecord | { error: string } {
    const headTip = this.branchTip(repo, input.head);
    if (headTip === null) return { error: `head branch ${input.head} has no commit` };
    const baseTip = this.branchTip(repo, input.base);
    if (baseTip === null) return { error: `base branch ${input.base} has no commit` };
    const existing = repo.pulls.find(
      (pull) => pull.headRef === input.head && pull.baseRef === input.base && pull.state === 'open',
    );
    if (existing !== undefined) return { error: 'a pull request is already open for this head and base' };
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const databaseId = this.#nextPullDbId;
    this.#nextPullDbId += 1;
    const now = trialIso();
    const pull: PullRecord = {
      id: globalId('PullRequest', `${repo.databaseId}:${number}`),
      databaseId,
      number,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: input.head,
      headSha: headTip,
      baseRef: input.base,
      baseSha: baseTip,
      createdAt: now,
      updatedAt: now,
    };
    repo.pulls.push(pull);
    return pull;
  }

  getPull(repo: Repo, number: number): PullRecord | undefined {
    return repo.pulls.find((pull) => pull.number === number);
  }

  listPulls(repo: Repo, state: string): PullRecord[] {
    if (state === 'all') return [...repo.pulls].sort((a, b) => b.number - a.number);
    return repo.pulls.filter((pull) => pull.state === state).sort((a, b) => b.number - a.number);
  }

  /** The files a pull request changes, between its base commit and its head tip. */
  pullFiles(repo: Repo, pull: PullRecord): FileDiff[] {
    const baseCommit = this.objects.get(pull.baseSha);
    const headTip = this.branchTip(repo, pull.headRef) ?? pull.headSha;
    const headCommit = this.objects.get(headTip);
    if (baseCommit === undefined || baseCommit.type !== 'commit') return [];
    if (headCommit === undefined || headCommit.type !== 'commit') return [];
    return diffTrees(parseCommit(baseCommit.data).tree, parseCommit(headCommit.data).tree, this.lookup);
  }

  /**
   * Whether a pull request conflicts with the base as it stands now: a file the
   * request changes was also changed on the base since the request was opened, to
   * different content. The three-way test, per file.
   */
  pullConflicts(repo: Repo, pull: PullRecord): boolean {
    const baseCommit = this.objects.get(pull.baseSha);
    if (baseCommit === undefined || baseCommit.type !== 'commit') return false;
    const currentBaseTip = this.branchTip(repo, pull.baseRef);
    if (currentBaseTip === null) return false;
    const currentBaseCommit = this.objects.get(currentBaseTip);
    if (currentBaseCommit === undefined || currentBaseCommit.type !== 'commit') return false;
    const headTip = this.branchTip(repo, pull.headRef) ?? pull.headSha;
    const headCommit = this.objects.get(headTip);
    if (headCommit === undefined || headCommit.type !== 'commit') return false;
    const atBase = flattenTree(parseCommit(baseCommit.data).tree, this.lookup);
    const atHead = flattenTree(parseCommit(headCommit.data).tree, this.lookup);
    const atCurrent = flattenTree(parseCommit(currentBaseCommit.data).tree, this.lookup);
    const changed = diffTrees(parseCommit(baseCommit.data).tree, parseCommit(headCommit.data).tree, this.lookup);
    for (const file of changed) {
      const baseOid = atBase.get(file.path)?.oid ?? null;
      const headOid = atHead.get(file.path)?.oid ?? null;
      const currentOid = atCurrent.get(file.path)?.oid ?? null;
      if (file.status === 'added') {
        if (currentOid !== null && currentOid !== headOid) return true;
      } else if (file.status === 'modified') {
        if (currentOid !== baseOid && currentOid !== headOid) return true;
      } else {
        if (currentOid !== null && currentOid !== baseOid) return true;
      }
    }
    return false;
  }

  /** Squash-merge a pull request onto its base branch. */
  mergePull(
    repo: Repo,
    number: number,
  ): { pull: PullRecord; mergeSha: string } | { error: 'not-found' | 'conflict' | 'closed' } {
    const pull = this.getPull(repo, number);
    if (pull === undefined) return { error: 'not-found' };
    if (pull.state !== 'open') return { error: 'closed' };
    if (this.pullConflicts(repo, pull)) return { error: 'conflict' };
    const currentBaseTip = this.branchTip(repo, pull.baseRef);
    if (currentBaseTip === null) return { error: 'not-found' };
    const currentBaseCommit = this.objects.get(currentBaseTip);
    if (currentBaseCommit === undefined || currentBaseCommit.type !== 'commit') return { error: 'not-found' };
    const headTip = this.branchTip(repo, pull.headRef) ?? pull.headSha;
    const headCommit = this.objects.get(headTip);
    if (headCommit === undefined || headCommit.type !== 'commit') return { error: 'not-found' };
    // The merged tree is the current base tree with the request's file changes applied.
    const baseFlat = flattenTree(parseCommit(currentBaseCommit.data).tree, this.lookup);
    const headFlat = flattenTree(parseCommit(headCommit.data).tree, this.lookup);
    const baseAtOpen = this.objects.get(pull.baseSha);
    const openTree =
      baseAtOpen !== undefined && baseAtOpen.type === 'commit'
        ? parseCommit(baseAtOpen.data).tree
        : parseCommit(currentBaseCommit.data).tree;
    const changed = diffTrees(openTree, parseCommit(headCommit.data).tree, this.lookup);
    const merged = new Map<string, string>();
    for (const [path, entry] of baseFlat) merged.set(path, entry.oid);
    for (const file of changed) {
      if (file.status === 'removed') merged.delete(file.path);
      else {
        const entry = headFlat.get(file.path);
        if (entry !== undefined) merged.set(file.path, entry.oid);
      }
    }
    const treeOid = buildTreeFromFiles(merged, (type, data) => this.putObject(type, data));
    const mergeSha = this.createCommit({
      tree: treeOid,
      parents: [currentBaseTip],
      message: `Merge pull request #${pull.number} from ${pull.headRef}`,
    });
    repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = trialIso();
    pull.mergeCommitSha = mergeSha;
    pull.updatedAt = trialIso();
    repo.updatedAt = trialIso();
    return { pull, mergeSha };
  }
}
