// GitHub REST v3: repositories, issues, pull requests, contents.
//
// Every reply is application/json with a non-empty X-GitHub-Request-Id. An unknown
// route is a JSON 404 {message}; a malformed JSON body is a 400 {message}; a
// missing or wrong Bearer token is a 401. A repository under any owner but the
// viewer is a 404, never a 403. Lists paginate with per_page (default 30) and page,
// and carry a Link header with absolute same-origin URLs. Extra fields are allowed
// in every shape, so each object carries both its GitHub fields and the forge's own
// ids where they help the other surfaces.

import { parseCommit } from './git-objects.ts';
import { VIEWER } from './scenario.ts';
import { issueJson, labelJson, pullJson, repoJson, commentJson, type Repo, type Store } from './store.ts';
import { b64decodeBuffer, b64encodeBuffer, isSha40, nextRequestId, trialIso, type JsonObject } from './util.ts';
import type { GitResponse } from './git-http.ts';

export function viewerJson(): Record<string, unknown> {
  return { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User' };
}

function json(status: number, body: unknown, extraHeaders: Record<string, string> = {}): GitResponse {
  return {
    status,
    contentType: 'application/json',
    body: Buffer.from(JSON.stringify(body)),
    headers: { 'x-github-request-id': nextRequestId(), ...extraHeaders },
  };
}

function message(status: number, text: string): GitResponse {
  return json(status, { message: text });
}

function notFound(text = 'Not Found'): GitResponse {
  return message(404, text);
}

function unauthorized(): GitResponse {
  return message(401, 'Bad credentials');
}

/** Parse a request body as JSON, or return the 400 to send when it is not JSON. */
function parseBody(body: Buffer): { value: JsonObject } | { error: GitResponse } {
  if (body.length === 0) return { value: {} };
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { error: message(400, 'Invalid JSON body') };
    }
    return { value: parsed as JsonObject };
  } catch {
    return { error: message(400, 'Invalid JSON body') };
  }
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** The page window for a list, from per_page (default 30) and page (default 1). */
function pageWindow(query: URLSearchParams): { perPage: number; page: number } {
  const perPageRaw = Number(query.get('per_page') ?? '30');
  const pageRaw = Number(query.get('page') ?? '1');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(Math.floor(perPageRaw), 100) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;
  return { perPage, page };
}

/** A Link header for a paginated list, with absolute same-origin URLs. */
function linkHeader(host: string, pathname: string, query: URLSearchParams, perPage: number, page: number, total: number): string {
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const urlFor = (target: number): string => {
    const next = new URLSearchParams(query);
    next.set('per_page', String(perPage));
    next.set('page', String(target));
    return `http://${host}${pathname}?${next.toString()}`;
  };
  const parts: string[] = [];
  if (page < totalPages) parts.push(`<${urlFor(page + 1)}>; rel="next"`);
  if (page > 1) parts.push(`<${urlFor(page - 1)}>; rel="prev"`);
  parts.push(`<${urlFor(1)}>; rel="first"`);
  parts.push(`<${urlFor(totalPages)}>; rel="last"`);
  return parts.join(', ');
}

function paginate<T>(items: readonly T[], query: URLSearchParams): { page: T[]; perPage: number; pageNumber: number } {
  const { perPage, page } = pageWindow(query);
  const start = (page - 1) * perPage;
  return { page: items.slice(start, start + perPage), perPage, pageNumber: page };
}

function listResponse<T>(
  items: readonly T[],
  host: string,
  pathname: string,
  query: URLSearchParams,
): GitResponse {
  const { page, perPage, pageNumber } = paginate(items, query);
  return json(200, page, { link: linkHeader(host, pathname, query, perPage, pageNumber, items.length) });
}

// -------------------------------------------------------------------------------------------
// route handlers
// -------------------------------------------------------------------------------------------

interface Ctx {
  store: Store;
  token: string;
  method: string;
  pathname: string;
  query: URLSearchParams;
  headers: Headers;
  body: Buffer;
  host: string;
}

function requireRepo(ctx: Ctx, owner: string, name: string): Repo | GitResponse {
  if (owner !== VIEWER.login) return notFound('Not Found');
  const repo = ctx.store.getRepo(owner, name);
  if (repo === undefined) return notFound('Not Found');
  return repo;
}

function identityJson(line: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/.exec(line);
  if (match === null) return { name: '', email: '', date: trialIso() };
  return { name: match[1] as string, email: match[2] as string, date: new Date(Number(match[3]) * 1000).toISOString() };
}

function commitJson(ctx: Ctx, repo: Repo, sha: string): Record<string, unknown> | null {
  const object = ctx.store.getObject(sha);
  if (object === undefined || object.type !== 'commit') return null;
  const view = parseCommit(object.data);
  return {
    sha,
    message: view.message.replace(/\n+$/, ''),
    commit: {
      message: view.message.replace(/\n+$/, ''),
      author: identityJson(view.author),
      committer: identityJson(view.committer),
    },
    author: identityJson(view.author),
    committer: identityJson(view.committer),
    parents: view.parents.map((parent) => ({ sha: parent })),
  };
}

function contentEntry(repo: Repo, path: string, entry: { name: string; path: string; oid: string; mode: string }): Record<string, unknown> {
  const isDir = entry.mode === '040000';
  return {
    type: isDir ? 'dir' : 'file',
    name: entry.name,
    path: entry.path,
    sha: entry.oid,
    size: isDir ? 0 : undefined,
    url: undefined,
  };
}

function handleContents(ctx: Ctx, repo: Repo, pathParts: string[]): GitResponse {
  const path = pathParts.join('/');
  const ref = ctx.query.get('ref') ?? undefined;
  if (ctx.method === 'GET') {
    const found = ctx.store.getContent(repo, path, ref);
    if ('error' in found) {
      const dir = ctx.store.listContentDir(repo, path, ref);
      // A directory in git always holds at least one entry, so an empty listing
      // means the path is neither a file nor a directory.
      if (dir === null || dir.length === 0) return notFound('Not Found');
      return json(200, dir.map((entry) => contentEntry(repo, path, entry)));
    }
    const name = path.split('/').pop() as string;
    return json(200, {
      type: 'file',
      encoding: 'base64',
      name,
      path,
      content: b64encodeBuffer(found.data),
      sha: found.oid,
      size: found.data.length,
    });
  }
  if (ctx.method === 'PUT') {
    const parsed = parseBody(ctx.body);
    if ('error' in parsed) return parsed.error;
    const input = parsed.value;
    const contentB64 = stringField(input.content);
    if (contentB64 === undefined) return message(400, 'content is required');
    let content: Buffer;
    try {
      content = b64decodeBuffer(contentB64);
    } catch {
      return message(400, 'content is not valid base64');
    }
    const messageText = stringField(input.message) ?? 'Update file';
    const branch = stringField(input.branch) ?? undefined;
    const expectedSha = stringField(input.sha) ?? undefined;
    const existing = ctx.store.getContent(repo, path, branch);
    const isUpdate = !('error' in existing);
    const result = ctx.store.putContent(repo, {
      path,
      content,
      message: messageText,
      branch,
      expectedSha,
    });
    if ('error' in result) {
      if (result.error === 'stale-sha') return message(409, 'sha does not match the current content');
      return notFound('Not Found');
    }
    const name = path.split('/').pop() as string;
    return json(isUpdate ? 200 : 201, {
      content: {
        type: 'file',
        encoding: 'base64',
        name,
        path,
        content: contentB64,
        sha: result.contentSha,
        size: content.length,
      },
      commit: { sha: result.commitSha, message: messageText },
    });
  }
  if (ctx.method === 'DELETE') {
    const parsed = parseBody(ctx.body);
    if ('error' in parsed) return parsed.error;
    const input = parsed.value;
    const messageText = stringField(input.message) ?? 'Delete file';
    const branch = stringField(input.branch) ?? undefined;
    const expectedSha = stringField(input.sha) ?? undefined;
    const result = ctx.store.deleteContent(repo, { path, message: messageText, branch, expectedSha });
    if ('error' in result) {
      if (result.error === 'stale-sha') return message(409, 'sha does not match the current content');
      return notFound('Not Found');
    }
    return json(200, { commit: { sha: result.commitSha, message: messageText } });
  }
  return message(405, 'Method Not Allowed');
}

function handleIssues(ctx: Ctx, repo: Repo, rest: string[]): GitResponse {
  if (rest.length === 0) {
    if (ctx.method === 'GET') {
      const issues = ctx.store.listIssues(repo, {
        state: ctx.query.get('state') ?? undefined,
        direction: ctx.query.get('direction') ?? undefined,
      });
      return listResponse(issues.map((issue) => issueJson(repo, issue)), ctx.host, ctx.pathname, ctx.query);
    }
    if (ctx.method === 'POST') {
      const parsed = parseBody(ctx.body);
      if ('error' in parsed) return parsed.error;
      const input = parsed.value;
      const title = stringField(input.title);
      if (title === undefined || title === '') return message(422, 'title is required');
      const labels = Array.isArray(input.labels)
        ? (input.labels as unknown[]).filter((label): label is string => typeof label === 'string')
        : [];
      const created = ctx.store.createIssue(repo, { title, body: stringField(input.body), labels });
      if ('error' in created) return message(422, `label ${JSON.stringify(created.label)} does not exist`);
      return json(201, issueJson(repo, created));
    }
    return message(405, 'Method Not Allowed');
  }
  const number = Number(rest[0]);
  if (!Number.isInteger(number) || number <= 0) return notFound('Not Found');
  if (rest.length === 2 && rest[1] === 'comments') {
    const issue = ctx.store.getIssue(repo, number);
    if (issue === undefined) return notFound('Not Found');
    if (ctx.method === 'GET') {
      return listResponse(issue.comments.map((comment) => commentJson(comment)), ctx.host, ctx.pathname, ctx.query);
    }
    if (ctx.method === 'POST') {
      const parsed = parseBody(ctx.body);
      if ('error' in parsed) return parsed.error;
      const text = stringField(parsed.value.body);
      if (text === undefined || text === '') return message(422, 'body is required');
      const comment = ctx.store.addComment(repo, number, text);
      if (comment === undefined) return notFound('Not Found');
      return json(201, commentJson(comment));
    }
    return message(405, 'Method Not Allowed');
  }
  if (rest.length !== 1) return notFound('Not Found');
  const issue = ctx.store.getIssue(repo, number);
  if (issue === undefined) return notFound('Not Found');
  if (ctx.method === 'GET') return json(200, issueJson(repo, issue));
  if (ctx.method === 'PATCH') {
    const parsed = parseBody(ctx.body);
    if ('error' in parsed) return parsed.error;
    const input = parsed.value;
    const state = stringField(input.state);
    if (state === 'closed' || state === 'open') ctx.store.setIssueState(repo, number, state);
    const title = stringField(input.title);
    if (title !== undefined) issue.title = title;
    const text = stringField(input.body);
    if (text !== undefined) issue.body = text;
    issue.updatedAt = trialIso();
    return json(200, issueJson(repo, issue));
  }
  return message(405, 'Method Not Allowed');
}

function handlePulls(ctx: Ctx, repo: Repo, rest: string[]): GitResponse {
  if (rest.length === 0) {
    if (ctx.method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      const pulls = ctx.store.listPulls(repo, state);
      return listResponse(pulls.map((pull) => pullJson(repo, pull, ctx.store)), ctx.host, ctx.pathname, ctx.query);
    }
    if (ctx.method === 'POST') {
      const parsed = parseBody(ctx.body);
      if ('error' in parsed) return parsed.error;
      const input = parsed.value;
      const head = stringField(input.head);
      const base = stringField(input.base);
      const title = stringField(input.title);
      if (head === undefined || base === undefined || title === undefined || title === '') {
        return message(422, 'head, base and title are required');
      }
      const created = ctx.store.createPull(repo, { head, base, title, body: stringField(input.body) });
      if ('error' in created) return message(422, created.error);
      return json(201, pullJson(repo, created, ctx.store));
    }
    return message(405, 'Method Not Allowed');
  }
  const number = Number(rest[0]);
  if (!Number.isInteger(number) || number <= 0) return notFound('Not Found');
  if (rest.length === 2 && rest[1] === 'files') {
    if (ctx.method !== 'GET') return message(405, 'Method Not Allowed');
    const pull = ctx.store.getPull(repo, number);
    if (pull === undefined) return notFound('Not Found');
    const files = ctx.store.pullFiles(repo, pull).map((file) => ({
      filename: file.path,
      status: file.status === 'removed' ? 'changed' : file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.additions + file.deletions,
    }));
    return json(200, files);
  }
  if (rest.length === 2 && rest[1] === 'merge') {
    if (ctx.method !== 'PUT') return message(405, 'Method Not Allowed');
    const merged = ctx.store.mergePull(repo, number);
    if ('error' in merged) {
      if (merged.error === 'not-found') return notFound('Not Found');
      return message(405, merged.error === 'conflict' ? 'Merge conflict' : 'Pull request is not open');
    }
    return json(200, {
      merged: true,
      sha: merged.mergeSha,
      message: 'Pull request successfully merged',
    });
  }
  if (rest.length !== 1) return notFound('Not Found');
  const pull = ctx.store.getPull(repo, number);
  if (pull === undefined) return notFound('Not Found');
  if (ctx.method === 'GET') return json(200, pullJson(repo, pull, ctx.store));
  return message(405, 'Method Not Allowed');
}

// -------------------------------------------------------------------------------------------
// dispatcher
// -------------------------------------------------------------------------------------------

/**
 * Route a REST v3 request. Returns null when the path is not under /api/v3, so the
 * caller can try the other surfaces.
 */
export function handleRest(
  store: Store,
  token: string,
  method: string,
  pathname: string,
  query: URLSearchParams,
  headers: Headers,
  body: Buffer,
  host: string,
): GitResponse | null {
  if (!pathname.startsWith('/api/v3')) return null;
  if (token !== '') {
    const presented = headers.get('authorization') ?? '';
    if (presented !== `Bearer ${token}`) return unauthorized();
  }
  const ctx: Ctx = { store, token, method, pathname, query, headers, body, host };
  const parts = pathname.split('/').filter((part) => part !== '');
  // parts: ['api', 'v3', ...]
  const rest = parts.slice(2);
  if (rest.length === 0) {
    if (method !== 'GET') return message(405, 'Method Not Allowed');
    return json(200, {}, { 'x-oauth-scopes': 'repo, read:org' });
  }
  if (rest[0] === 'meta' && rest.length === 1) {
    if (method !== 'GET') return message(405, 'Method Not Allowed');
    return json(200, { installed_version: '1.0.0' });
  }
  if (rest[0] === 'user' && rest.length === 1) {
    if (method !== 'GET') return message(405, 'Method Not Allowed');
    return json(200, viewerJson());
  }
  if (rest[0] === 'user' && rest[1] === 'repos' && rest.length === 2) {
    if (method === 'GET') {
      const repos = store.listRepos(VIEWER.login);
      return listResponse(repos.map((repo) => repoJson(repo)), host, pathname, query);
    }
    if (method === 'POST') {
      const parsed = parseBody(body);
      if ('error' in parsed) return parsed.error;
      const input = parsed.value;
      const name = stringField(input.name);
      if (name === undefined || name === '') return message(422, 'name is required');
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) return message(422, 'name is invalid');
      const created = store.createRepo(VIEWER.login, name, {
        private: typeof input.private === 'boolean' ? input.private : true,
        description: stringField(input.description) ?? '',
      });
      if (created === null) return message(422, 'name already exists on this account');
      return json(201, repoJson(created));
    }
    return message(405, 'Method Not Allowed');
  }
  if (rest[0] !== 'repos' || rest.length < 3) return notFound('Not Found');
  const owner = rest[1] as string;
  const name = rest[2] as string;
  const repoOrError = requireRepo(ctx, owner, name);
  if ('status' in repoOrError) return repoOrError;
  const repo = repoOrError;
  const tail = rest.slice(3);
  if (tail.length === 0) {
    if (method === 'GET') return json(200, repoJson(repo));
    if (method === 'PATCH') {
      const parsed = parseBody(body);
      if ('error' in parsed) return parsed.error;
      const input = parsed.value;
      const description = stringField(input.description);
      if (description !== undefined) repo.description = description;
      if (typeof input.private === 'boolean') repo.private = input.private;
      repo.updatedAt = trialIso();
      return json(200, repoJson(repo));
    }
    if (method === 'DELETE') {
      store.deleteRepo(owner, name);
      return { status: 204, contentType: 'application/json', body: Buffer.alloc(0), headers: { 'x-github-request-id': nextRequestId() } };
    }
    return message(405, 'Method Not Allowed');
  }
  if (tail[0] === 'branches' && tail.length === 1) {
    if (method !== 'GET') return message(405, 'Method Not Allowed');
    const branches = [...repo.refs.keys()]
      .filter((ref) => ref.startsWith('refs/heads/'))
      .map((ref) => ref.slice('refs/heads/'.length))
      .sort()
      .map((branch) => ({
        name: branch,
        commit: { sha: store.branchTip(repo, branch) },
        protected: false,
      }));
    return listResponse(branches, host, pathname, query);
  }
  if (tail[0] === 'commits' && tail.length === 1) {
    if (method !== 'GET') return message(405, 'Method Not Allowed');
    const ref = query.get('sha') ?? undefined;
    const commits = store.listCommits(repo, ref);
    const items = commits
      .map((entry) => commitJson(ctx, repo, entry.sha))
      .filter((entry): entry is Record<string, unknown> => entry !== null);
    return listResponse(items, host, pathname, query);
  }
  if (tail[0] === 'git' && tail[1] === 'refs') {
    if (method === 'GET' && tail.length === 2) {
      const refs = [...repo.refs.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map(([ref, oid]) => {
          const object = store.getObject(oid);
          return { ref, object: { sha: oid, type: object?.type ?? 'commit' } };
        });
      return listResponse(refs, host, pathname, query);
    }
    if (method === 'GET' && tail.length > 2) {
      const ref = `refs/${tail.slice(2).join('/')}`;
      const oid = repo.refs.get(ref);
      if (oid === undefined) return notFound('Not Found');
      const object = store.getObject(oid);
      return json(200, { ref, object: { sha: oid, type: object?.type ?? 'commit' } });
    }
    if (method === 'POST' && tail.length === 2) {
      const parsed = parseBody(body);
      if ('error' in parsed) return parsed.error;
      const input = parsed.value;
      const ref = stringField(input.ref);
      const sha = stringField(input.sha);
      if (ref === undefined || !ref.startsWith('refs/') || sha === undefined || !isSha40(sha)) {
        return message(422, 'ref and sha are required');
      }
      if (repo.refs.has(ref)) return message(422, 'Reference already exists');
      const object = store.getObject(sha);
      if (object === undefined) return message(422, 'sha does not exist');
      repo.refs.set(ref, sha);
      repo.updatedAt = trialIso();
      return json(201, { ref, object: { sha, type: object.type } });
    }
    return message(405, 'Method Not Allowed');
  }
  if (tail[0] === 'contents') {
    if (tail.length < 2) return notFound('Not Found');
    return handleContents(ctx, repo, tail.slice(1));
  }
  if (tail[0] === 'issues') return handleIssues(ctx, repo, tail.slice(1));
  if (tail[0] === 'pulls') return handlePulls(ctx, repo, tail.slice(1));
  if (tail[0] === 'labels') {
    if (method === 'GET' && tail.length === 1) {
      return listResponse(repo.labels.map((label) => labelJson(label)), host, pathname, query);
    }
    if (method === 'POST' && tail.length === 1) {
      const parsed = parseBody(body);
      if ('error' in parsed) return parsed.error;
      const input = parsed.value;
      const labelName = stringField(input.name);
      if (labelName === undefined || labelName === '') return message(422, 'name is required');
      const label = store.createLabel(repo, labelName, stringField(input.color) ?? '');
      return json(201, labelJson(label));
    }
    return message(405, 'Method Not Allowed');
  }
  return notFound('Not Found');
}
