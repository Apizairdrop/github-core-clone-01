// The HTTP server: one process, stdlib only. It routes each request to exactly one
// surface — git smart-HTTP, REST v3, GraphQL v4, MCP — or to the health check. The
// body is read whole (packs are binary; a 100 MB cap keeps a runaway client from
// exhausting the pod) and handed to the surface as a Buffer. A surface that throws
// answers 500 instead of dropping the connection, so one bad request cannot end a
// trial; the trial's own surfaces are written not to throw.

import http from 'node:http';
import { handleGit } from './git-http.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMCP } from './mcp.ts';
import { nextRequestId } from './util.ts';
import type { Store } from './store.ts';

const MAX_BODY_BYTES = 100 * 1024 * 1024;

export interface ServerOptions {
  store: Store;
  token: string;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': payload.length,
    'x-github-request-id': nextRequestId(),
  });
  res.end(payload);
}

export function createServer(options: ServerOptions): http.Server {
  const { store, token } = options;
  return http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) {
        sendJson(res, 413, { message: 'request body too large' });
        return;
      }
      const body = Buffer.concat(chunks);
      let url: URL;
      try {
        url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      } catch {
        sendJson(res, 400, { message: 'bad request URL' });
        return;
      }
      const pathname = url.pathname;
      const method = req.method ?? 'GET';
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') headers.set(name, value);
        else if (Array.isArray(value)) headers.set(name, value.join(', '));
      }
      try {
        if (pathname === '/healthz') {
          if (method !== 'GET') {
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          sendJson(res, 200, { ok: true });
          return;
        }
        const host = req.headers.host ?? '127.0.0.1';
        const git = handleGit(store, token, method, pathname, url.searchParams, headers, body);
        if (git !== null) {
          sendResponse(res, git);
          return;
        }
        const rest = handleRest(store, token, method, pathname, url.searchParams, headers, body, host);
        if (rest !== null) {
          sendResponse(res, rest);
          return;
        }
        const graphql = handleGraphQL(store, token, method, pathname, headers, body);
        if (graphql !== null) {
          sendResponse(res, graphql);
          return;
        }
        const mcp = handleMCP(store, token, method, pathname, headers, body);
        if (mcp !== null) {
          sendResponse(res, mcp);
          return;
        }
        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        console.error(err instanceof Error ? err.stack ?? err.message : String(err));
        sendJson(res, 500, { message: `internal error: ${detail}` });
      }
    });
    req.on('error', () => {
      try {
        sendJson(res, 400, { message: 'bad request' });
      } catch {
        // The socket is already gone; nothing left to do.
      }
    });
  });
}

function sendResponse(
  res: http.ServerResponse,
  response: { status: number; contentType: string; body: Buffer; headers?: Record<string, string> },
): void {
  const headers: Record<string, string> = {
    'content-type': response.contentType,
    'content-length': String(response.body.length),
  };
  for (const [name, value] of Object.entries(response.headers ?? {})) {
    headers[name.toLowerCase()] = value;
  }
  // REST answers always carry a request id; the git and MCP surfaces do not need one.
  if (response.contentType === 'application/json' && headers['x-github-request-id'] === undefined) {
    headers['x-github-request-id'] = nextRequestId();
  }
  res.writeHead(response.status, headers);
  res.end(response.body);
}
