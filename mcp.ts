// MCP: JSON-RPC 2.0 over POST /mcp, both protocol eras.
//
// Modern (2026-07-28): `server/discover` returns the identity, the supported
// revisions and the capabilities in one request; there is no session. Legacy
// (2025-11-25 and earlier): `initialize` negotiates a revision, then
// `notifications/initialized` (a notification, answered 202 with no body). The
// tool list is a frozen constant, so two `tools/list` answers are byte-identical.
// Tool calls run against the same store REST and GraphQL read from. A missing or
// wrong Bearer token is a 401; a body that is not JSON is HTTP 400 with JSON-RPC
// -32700 and a null id; an unknown tool is -32602; a missing required argument is
// an isError tool result, never an HTTP 500.

import { VIEWER } from './scenario.ts';
import { issueJson, pullJson, repoJson, type Store } from './store.ts';
import type { GitResponse } from './git-http.ts';

const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: readonly ToolDef[] = Object.freeze([
  Object.freeze({
    name: 'create_repo',
    description: 'Create a repository for the viewer.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      }),
      required: Object.freeze(['name']),
    }),
  }),
  Object.freeze({
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      }),
      required: Object.freeze(['owner', 'repo', 'title']),
    }),
  }),
  Object.freeze({
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed, or all.' },
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_pull_request',
    description: 'Open a pull request from one branch onto another.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The branch the changes come from.' },
        base: { type: 'string', description: 'The branch the changes go onto.' },
      }),
      required: Object.freeze(['owner', 'repo', 'title', 'head', 'base']),
    }),
  }),
  Object.freeze({
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request onto its base branch.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      }),
      required: Object.freeze(['owner', 'repo', 'pull_number']),
    }),
  }),
]);

type RpcId = string | number | null;

function rpcResult(id: RpcId, result: unknown): GitResponse {
  return { status: 200, contentType: 'application/json', body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result })) };
}

function rpcError(id: RpcId, code: number, message: string, status = 200): GitResponse {
  return { status, contentType: 'application/json', body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })) };
}

function toolText(payload: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function missingArg(args: Record<string, unknown>, name: string): Record<string, unknown> | null {
  const value = args[name];
  if (value === undefined || value === null || value === '') {
    return toolError(`missing required argument: ${name}`);
  }
  return null;
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  if (name === 'create_repo') {
    const missing = missingArg(args, 'name');
    if (missing !== null) return missing;
    const repoName = String(args.name);
    const created = store.createRepo(VIEWER.login, repoName, {
      private: typeof args.private === 'boolean' ? args.private : true,
      description: typeof args.description === 'string' ? args.description : '',
    });
    if (created === null) return toolError(`repository ${repoName} already exists`);
    return toolText(repoJson(created));
  }
  if (name === 'get_repo' || name === 'create_issue' || name === 'list_issues' || name === 'create_pull_request' || name === 'merge_pull_request') {
    const missingOwner = missingArg(args, 'owner');
    if (missingOwner !== null) return missingOwner;
    const missingRepo = missingArg(args, 'repo');
    if (missingRepo !== null) return missingRepo;
    const owner = String(args.owner);
    const repoName = String(args.repo);
    if (owner !== VIEWER.login) return toolError(`repository ${owner}/${repoName} not found`);
    const repo = store.getRepo(owner, repoName);
    if (repo === undefined) return toolError(`repository ${owner}/${repoName} not found`);
    if (name === 'get_repo') return toolText(repoJson(repo));
    if (name === 'list_issues') {
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = store.listIssues(repo, { state, direction: 'desc' });
      return toolText(issues.map((issue) => issueJson(repo, issue)));
    }
    if (name === 'create_issue') {
      const missing = missingArg(args, 'title');
      if (missing !== null) return missing;
      const created = store.createIssue(repo, {
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
      });
      if ('error' in created) return toolError(`label ${JSON.stringify(created.label)} does not exist`);
      return toolText(issueJson(repo, created));
    }
    if (name === 'create_pull_request') {
      for (const field of ['title', 'head', 'base']) {
        const missing = missingArg(args, field);
        if (missing !== null) return missing;
      }
      const created = store.createPull(repo, {
        head: String(args.head),
        base: String(args.base),
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
      });
      if ('error' in created) return toolError(created.error);
      return toolText(pullJson(repo, created, store));
    }
    // merge_pull_request
    const missing = missingArg(args, 'pull_number');
    if (missing !== null) return missing;
    const number = Number(args.pull_number);
    if (!Number.isInteger(number) || number <= 0) return toolError('pull_number must be a positive integer');
    const merged = store.mergePull(repo, number);
    if ('error' in merged) {
      if (merged.error === 'not-found') return toolError(`pull request #${number} not found`);
      return toolError(merged.error === 'conflict' ? 'Merge conflict' : 'Pull request is not open');
    }
    return toolText({ merged: true, sha: merged.mergeSha, number: merged.pull.number, state: merged.pull.state });
  }
  return toolError(`unknown tool: ${name}`);
}

/**
 * Route an MCP request. Returns null when the path is not /mcp, so the caller can
 * try the other surfaces.
 */
export function handleMCP(
  store: Store,
  token: string,
  method: string,
  pathname: string,
  headers: Headers,
  body: Buffer,
): GitResponse | null {
  if (pathname !== '/mcp') return null;
  if (method !== 'POST') {
    return { status: 405, contentType: 'application/json', body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Method Not Allowed' } })) };
  }
  if (token !== '') {
    const presented = headers.get('authorization') ?? '';
    if (presented !== `Bearer ${token}`) {
      return { status: 401, contentType: 'application/json', body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Bad credentials' } })) };
    }
  }
  let request: unknown;
  try {
    request = JSON.parse(body.toString('utf8'));
  } catch {
    return rpcError(null, -32700, 'Parse error', 400);
  }
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    return rpcError(null, -32600, 'Invalid Request');
  }
  const record = request as Record<string, unknown>;
  const id = (record.id as RpcId) ?? null;
  const isNotification = record.id === undefined;
  const rpcMethod = typeof record.method === 'string' ? record.method : '';
  const params = (record.params ?? {}) as Record<string, unknown>;
  if (isNotification) {
    // A notification (notably notifications/initialized) needs no answer: 202, no body.
    return { status: 202, contentType: 'application/json', body: Buffer.alloc(0) };
  }
  if (rpcMethod === 'server/discover') {
    return rpcResult(id, {
      protocolVersion: SUPPORTED_VERSIONS[0],
      supportedVersions: [...SUPPORTED_VERSIONS],
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      capabilities: { tools: {} },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
  }
  if (rpcMethod === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    if (!(SUPPORTED_VERSIONS as readonly string[]).includes(offered)) {
      return rpcError(id, -32602, `unsupported protocol version ${JSON.stringify(offered)}`);
    }
    return rpcResult(id, {
      protocolVersion: offered,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (rpcMethod === 'ping') return rpcResult(id, {});
  if (rpcMethod === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }
  if (rpcMethod === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const known = TOOLS.some((tool) => tool.name === toolName);
    if (!known) return rpcError(id, -32602, `unknown tool: ${toolName}`);
    return rpcResult(id, callTool(store, toolName, args));
  }
  return rpcError(id, -32601, `method not found: ${rpcMethod}`);
}
