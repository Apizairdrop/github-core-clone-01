# github-core-clone-01 — a GitHub-compatible git forge

A standalone git forge in one Node.js process, written for the [make.fun](https://make.fun) bounty **github-core-clone-01** ("Build a GitHub-compatible git forge"). It implements the git object model itself — no git binary, no runtime dependencies, no network — and serves it over four surfaces at once:

- **Git smart-HTTP** — `info/refs`, `upload-pack` (protocol v2 with `ls-refs`/`fetch`, and v0), and `receive-pack` (v0) with shallow clones, fast-forward checks and sideband reporting.
- **GitHub REST v3** — repositories, branches, commits, contents, issues, labels, comments and pull requests under `/api/v3`, with pagination and request ids.
- **GraphQL v4** — `repository`, `viewer`, `node(id:)` and `__type` introspection plus the `createIssue`, `closeIssue`, `createPullRequest`, `mergePullRequest` and `addComment` mutations at `/api/graphql`, sharing the same store and the same opaque global ids as REST.
- **MCP** — `server/discover` and the legacy `initialize` handshake, `tools/list` and `tools/call` at `/mcp`, with six tools (`create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`).

Everything lives in memory and is deterministic: timestamps come from `MAKEFUN_TRIAL_NOW`, the scenario seed from `MAKEFUN_TRIAL_SEED`, and ids from counters, so a replay leaves the same state as the live pass.

## How to run it

Requires Node.js 22.18 or newer. No install step — the standard library is all it uses.

```sh
MAKEFUN_SHOP_TOKEN=your-token node --experimental-strip-types main.ts
```

or, with npm:

```sh
npm start
```

The server binds an ephemeral port and prints where it listens. In a trial it registers that port with `$MAKEFUN_ENV_URL` and exits when the environment reports done; without `MAKEFUN_ENV_URL` it simply stays up.

Set `MAKEFUN_SHOP_TOKEN` to the token clients must present as a Bearer token. `GET /healthz` answers `{"ok": true}` without one.

## Layout

| File | Job |
| --- | --- |
| `main.ts` | Entrypoint: bind, register, wait for done. |
| `app.ts` | The HTTP server and routing between surfaces. |
| `git-http.ts` | Smart-HTTP: advertisements, ls-refs, fetch (v0/v2), receive-pack. |
| `git-objects.ts` | Git objects: hashing, commits/trees/tags, packfiles, pkt-lines, reachability. |
| `store.ts` | The in-memory store: repos, refs, contents, issues, pull requests. |
| `rest.ts` | GitHub REST v3. |
| `graphql.ts` | GraphQL v4: parser, executor, schema. |
| `mcp.ts` | MCP: discover/initialize, tools/list, tools/call. |
| `scenario.ts` | The fixed scenario seed and the viewer identity it derives. |
| `util.ts` | Hashing, ids, timestamps, base64, request ids. |

Built for the bounty at https://make.fun/bounty/github-core-clone-01.
