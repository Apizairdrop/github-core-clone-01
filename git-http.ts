// Git smart-HTTP: info/refs, upload-pack (protocol v0 and v2), receive-pack (v0).
//
// The wire shapes here are the ones the kit's harness client speaks: the v2
// advertisement (`version 2` + one capability per pkt-line), v2 ls-refs (with peel,
// symrefs, unborn and ref-prefix), v2 fetch (acknowledgments / shallow-info /
// packfile sections, sideband band 1 for the pack), v0 fetch (want/have/done with
// side-band-64k, ACK/NAK then shallow/unshallow lines then the pack), and v0
// receive-pack (command list, then the pack, then a report-status stream inside
// sideband band 1). A missing repository answers 404 on every git route; a missing
// or wrong Bearer token answers 401. A repository under any owner but the viewer
// answers 404, never 403.

import {
  collectHeld,
  decodePktLines,
  encodePktLine,
  encodePktLines,
  parseCommit,
  parseTree,
  readPack,
  verifyPackChecksum,
  writePack,
  ZERO_OID,
  type GitObject,
  type PktLine,
} from './git-objects.ts';
import { VIEWER } from './scenario.ts';
import { isSha40, trialIso } from './util.ts';
import type { Repo, Store } from './store.ts';

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
  headers?: Record<string, string>;
}

const AGENT = 'forge/1.0';
const UPLOAD_V2_CAPABILITIES = ['agent=forge/1.0', 'ls-refs=unborn', 'fetch=shallow', 'object-format=sha1'];
const UPLOAD_V0_CAPABILITIES = `side-band-64k multi_ack thin-pack ofs-delta shallow symref=HEAD:refs/heads/main agent=${AGENT}`;
const RECEIVE_V0_CAPABILITIES = `report-status side-band-64k delete-refs ofs-delta symref=HEAD:refs/heads/main agent=${AGENT}`;

/** A pkt-line payload may hold at most 65520 bytes; one byte is the sideband band. */
const SIDEBAND_CHUNK = 65515;

/** The commit timestamp from a committer line ("Name <mail> 1735689600 +0000"). */
function committerTimestamp(committer: string): number {
  const match = / (\d+) [+-]\d{4}$/.exec(committer);
  return match !== null ? Number(match[1]) : 0;
}

/** Every tree and blob id under a tree, the tree itself included, gitlinks skipped. */
function treeObjects(treeOid: string, lookup: (oid: string) => GitObject | undefined): Set<string> {
  const out = new Set<string>();
  const stack = [treeOid];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (out.has(oid) || oid === ZERO_OID) continue;
    const object = lookup(oid);
    if (object === undefined) continue;
    out.add(oid);
    if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        stack.push(entry.oid);
      }
    }
  }
  return out;
}

export interface FetchPlan {
  /** The objects to pack, in oid order (writePack sorts). */
  objects: GitObject[];
  /** The wants, held by the client or unknown, that contributed nothing. */
  acks: string[];
  nak: boolean;
  shallow: string[];
  unshallow: string[];
}

export interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  deepenSince: number | null;
  deepenNot: string[];
}

/**
 * Work out what a fetch sends. Breadth-first from the wants (a want is depth 1):
 * a commit the client already holds in full is neither sent nor walked past; a commit
 * the client holds shallowly is walked past when the depth allows, so its parents can
 * be sent. Commits at the depth limit are the new shallow boundary. The objects the
 * client holds are subtracted, so shared blobs and trees are never re-sent. A client
 * shallow boundary whose parent is now sent stops being shallow.
 */
export function planFetch(store: Store, repo: Repo, request: FetchRequest): FetchPlan {
  const lookup = store.lookup;
  const haveSet = new Set(request.haves);
  const clientShallow = new Set(request.shallow);
  // A deepen-not ref behaves like a have the client already holds in full.
  for (const ref of request.deepenNot) {
    const resolved = store.resolveRef(repo, ref);
    if (resolved !== null) haveSet.add(resolved);
  }
  const sendCommits = new Set<string>();
  const boundary = new Set<string>();
  const tagWants = new Set<string>();
  const queue: Array<{ oid: string; depth: number }> = [];
  for (const want of request.wants) {
    const object = store.getObject(want);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      tagWants.add(want);
      queue.push({ oid: store.peelToCommit(want), depth: 1 });
    } else if (object.type === 'commit') {
      queue.push({ oid: want, depth: 1 });
    }
  }
  const visited = new Set<string>();
  while (queue.length > 0) {
    const { oid, depth } = queue.shift() as { oid: string; depth: number };
    if (visited.has(oid) || oid === ZERO_OID) continue;
    visited.add(oid);
    if (haveSet.has(oid) && !clientShallow.has(oid)) continue;
    sendCommits.add(oid);
    const isBoundary =
      (request.depth !== null && depth >= request.depth) ||
      (request.deepenSince !== null &&
        (() => {
          const object = store.getObject(oid);
          if (object === undefined || object.type !== 'commit') return false;
          return committerTimestamp(parseCommit(object.data).committer) < (request.deepenSince as number);
        })());
    if (isBoundary) {
      boundary.add(oid);
      continue;
    }
    const object = store.getObject(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      queue.push({ oid: parent, depth: depth + 1 });
    }
  }
  const held = collectHeld([...haveSet], clientShallow, lookup);
  const send = new Set<string>();
  for (const oid of sendCommits) {
    send.add(oid);
    const object = store.getObject(oid);
    if (object !== undefined && object.type === 'commit') {
      for (const entry of treeObjects(parseCommit(object.data).tree, lookup)) send.add(entry);
    }
  }
  for (const oid of tagWants) send.add(oid);
  for (const oid of held) send.delete(oid);
  const objects: GitObject[] = [];
  for (const oid of send) {
    const object = store.getObject(oid);
    if (object !== undefined) objects.push(object);
  }
  const acks: string[] = [];
  for (const have of request.haves) {
    if (store.getObject(have) !== undefined) acks.push(have);
  }
  const unshallow: string[] = [];
  for (const boundaryOid of clientShallow) {
    const object = store.getObject(boundaryOid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (sendCommits.has(parent) || send.has(parent)) {
        unshallow.push(boundaryOid);
        break;
      }
    }
  }
  return { objects, acks, nak: acks.length === 0, shallow: [...boundary], unshallow };
}

/** A packfile section's sideband pkt-lines: band 1, chunks of at most 65515 bytes. */
function sidebandPack(pack: Buffer): Buffer[] {
  const lines: Buffer[] = [];
  for (let at = 0; at < pack.length; at += SIDEBAND_CHUNK) {
    const chunk = pack.subarray(at, Math.min(pack.length, at + SIDEBAND_CHUNK));
    lines.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (lines.length === 0) lines.push(encodePktLine(Buffer.concat([Buffer.from([1]), pack])));
  return lines;
}

/** Parse a request body that is only pkt-lines, into its data lines (without trailing \n). */
function pktLines(body: Buffer): PktLine[] {
  return decodePktLines(body);
}

function lineText(packet: PktLine): string {
  return packet.payload.toString('utf8').replace(/\n$/, '');
}

/** Split a v0/v2 upload-pack or ls-refs request body into its argument lines. */
function requestArgs(body: Buffer): string[] {
  const args: string[] = [];
  for (const packet of pktLines(body)) {
    if (packet.kind === 'data') args.push(lineText(packet));
  }
  return args;
}

// -------------------------------------------------------------------------------------------
// advertisements and ref listings
// -------------------------------------------------------------------------------------------

/** All refs of a repo, sorted by name: branches, tags, and HEAD first. */
function listRefs(store: Store, repo: Repo): Array<{ oid: string; name: string; peeled?: string; symrefTarget?: string }> {
  const out: Array<{ oid: string; name: string; peeled?: string; symrefTarget?: string }> = [];
  const headTip = store.branchTip(repo);
  if (headTip !== null) {
    out.push({ oid: headTip, name: 'HEAD', symrefTarget: `refs/heads/${repo.defaultBranch}` });
  }
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    const entry: { oid: string; name: string; peeled?: string } = { oid, name };
    const object = store.getObject(oid);
    if (object !== undefined && object.type === 'tag') {
      entry.peeled = store.peelToCommit(oid);
    }
    out.push(entry);
  }
  return out;
}

/** The v0 advertisement for a service: service preamble, flush, ref lines, flush. */
function v0Advertisement(store: Store, repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const capabilities = service === 'git-upload-pack' ? UPLOAD_V0_CAPABILITIES : RECEIVE_V0_CAPABILITIES;
  const lines: Array<string | 'flush'> = [`# service=${service}\n`, 'flush'];
  const refs = listRefs(store, repo);
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\u0000${capabilities}\n`);
  } else {
    let first = true;
    for (const ref of refs) {
      const suffix = first ? `\u0000${capabilities}` : '';
      first = false;
      lines.push(`${ref.oid} ${ref.name}${suffix}\n`);
      if (ref.peeled !== undefined) lines.push(`${ref.peeled} ${ref.name}^{}\n`);
    }
  }
  lines.push('flush');
  return encodePktLines(lines);
}

/** The v2 advertisement for upload-pack: service preamble, flush, version, capabilities, flush. */
function v2Advertisement(): Buffer {
  const lines: Array<string | 'flush'> = ['# service=git-upload-pack\n', 'flush', 'version 2\n'];
  for (const capability of UPLOAD_V2_CAPABILITIES) lines.push(`${capability}\n`);
  lines.push('flush');
  return encodePktLines(lines);
}

/** The v2 ls-refs answer: one pkt-line per ref, then a flush. */
function lsRefsResponse(
  store: Store,
  repo: Repo,
  args: { peel: boolean; symrefs: boolean; unborn: boolean; prefixes: string[] },
): Buffer {
  const refs = listRefs(store, repo);
  const lines: Array<string | 'flush'> = [];
  const keep = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  if (refs.length === 0) {
    if (args.unborn && keep('HEAD')) {
      lines.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
    }
  } else {
    for (const ref of refs) {
      if (!keep(ref.name)) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (args.symrefs && ref.symrefTarget !== undefined) line += ` symref-target:${ref.symrefTarget}`;
      if (args.peel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
      lines.push(`${line}\n`);
    }
  }
  lines.push('flush');
  return encodePktLines(lines);
}

// -------------------------------------------------------------------------------------------
// upload-pack: v2 fetch, v0 fetch
// -------------------------------------------------------------------------------------------

function parseFetchArgs(args: string[]): FetchRequest {
  const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: null, deepenSince: null, deepenNot: [] };
  for (const arg of args) {
    if (arg.startsWith('want ')) {
      // A v0 first want may carry features after the oid; take the oid only.
      const rest = arg.slice(5).trim();
      const oid = rest.split(' ')[0] as string;
      if (isSha40(oid)) request.wants.push(oid);
    } else if (arg.startsWith('have ')) {
      const oid = arg.slice(5).trim();
      if (isSha40(oid)) request.haves.push(oid);
    } else if (arg.startsWith('shallow ')) {
      const oid = arg.slice(8).trim();
      if (isSha40(oid)) request.shallow.push(oid);
    } else if (arg.startsWith('deepen ')) {
      const depth = Number(arg.slice(7).trim());
      if (Number.isFinite(depth) && depth > 0) request.depth = depth;
    } else if (arg.startsWith('deepen-since ')) {
      const since = Number(arg.slice(13).trim());
      if (Number.isFinite(since)) request.deepenSince = since;
    } else if (arg.startsWith('deepen-not ')) {
      request.deepenNot.push(arg.slice(11).trim());
    }
  }
  return request;
}

/** The v2 fetch answer: acknowledgments, shallow-info, packfile — sections end with a delim, the body with a flush. */
function v2FetchResponse(store: Store, repo: Repo, request: FetchRequest): Buffer {
  const plan = planFetch(store, repo, request);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  const ackLines: Array<string | 'delim'> = ['acknowledgments\n'];
  if (plan.nak) ackLines.push('NAK\n');
  else for (const oid of plan.acks) ackLines.push(`ACK ${oid}\n`);
  ackLines.push('ready\n', 'delim');
  parts.push(encodePktLines(ackLines));
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    const shallowLines: Array<string | 'delim'> = ['shallow-info\n'];
    for (const oid of plan.shallow) shallowLines.push(`shallow ${oid}\n`);
    for (const oid of plan.unshallow) shallowLines.push(`unshallow ${oid}\n`);
    shallowLines.push('delim');
    parts.push(encodePktLines(shallowLines));
  }
  parts.push(encodePktLines(['packfile\n']));
  for (const line of sidebandPack(pack)) parts.push(line);
  parts.push(encodePktLines(['flush']));
  return Buffer.concat(parts);
}

/** The v0 fetch answer: ACK/NAK, shallow/unshallow lines, then the pack as sideband, then a flush. */
function v0FetchResponse(store: Store, repo: Repo, request: FetchRequest): Buffer {
  const plan = planFetch(store, repo, request);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  const head: string[] = [];
  if (plan.nak) head.push('NAK\n');
  else for (const oid of plan.acks) head.push(`ACK ${oid}\n`);
  for (const oid of plan.shallow) head.push(`shallow ${oid}\n`);
  for (const oid of plan.unshallow) head.push(`unshallow ${oid}\n`);
  parts.push(encodePktLines(head));
  for (const line of sidebandPack(pack)) parts.push(line);
  parts.push(encodePktLines(['flush']));
  return Buffer.concat(parts);
}

/** Handle POST /{owner}/{repo}.git/git-upload-pack (v2 when the client asked for it). */
function handleUploadPack(store: Store, repo: Repo, body: Buffer, version2: boolean): GitResponse {
  const args = requestArgs(body);
  const first = args[0] ?? '';
  if (version2 && first === 'command=ls-refs') {
    const parsed = { peel: false, symrefs: false, unborn: false, prefixes: [] as string[] };
    for (const arg of args.slice(1)) {
      if (arg === 'peel') parsed.peel = true;
      else if (arg === 'symrefs') parsed.symrefs = true;
      else if (arg === 'unborn') parsed.unborn = true;
      else if (arg.startsWith('ref-prefix ')) parsed.prefixes.push(arg.slice(11));
    }
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: lsRefsResponse(store, repo, parsed) };
  }
  if (version2 && first !== 'command=fetch') {
    return { status: 400, contentType: 'text/plain', body: Buffer.from(`unsupported upload-pack command ${JSON.stringify(first)}\n`) };
  }
  const request = parseFetchArgs(args);
  const responseBody = version2 ? v2FetchResponse(store, repo, request) : v0FetchResponse(store, repo, request);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: responseBody };
}

// -------------------------------------------------------------------------------------------
// receive-pack: push
// -------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/**
 * Split a receive-pack body into its command lines and the pack that follows the
 * flush. The pack is raw bytes, not pkt-lines, so the split is done by hand.
 */
function splitPushBody(body: Buffer): { commands: PushCommand[]; capabilities: string[]; pack: Buffer } | { error: string } {
  const commands: PushCommand[] = [];
  let capabilities: string[] = [];
  let at = 0;
  let first = true;
  while (at + 4 <= body.length) {
    const length = parseInt(body.subarray(at, at + 4).toString('ascii'), 16);
    if (Number.isNaN(length) || length < 0 || length > 65520) return { error: 'bad pkt-line length in push' };
    if (length === 0) {
      at += 4;
      break;
    }
    if (length === 1 || length === 2) return { error: 'unexpected control packet in push' };
    if (at + length > body.length) return { error: 'truncated pkt-line in push' };
    const text = body.subarray(at + 4, at + length).toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\u0000');
    let line = text;
    if (first && nul >= 0) {
      line = text.slice(0, nul);
      capabilities = text.slice(nul + 1).split(' ').filter(Boolean);
    }
    first = false;
    const parts = line.split(' ');
    if (parts.length < 3 || !isSha40(parts[0] as string) || !isSha40(parts[1] as string)) {
      return { error: `bad push command ${JSON.stringify(line.slice(0, 60))}` };
    }
    commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts.slice(2).join(' ') });
    at += length;
  }
  if (commands.length === 0) return { error: 'push carries no commands' };
  return { commands, capabilities, pack: body.subarray(at) };
}

/**
 * Apply one push command. A create needs the ref absent; an update needs the old
 * value to match the tip and the new value to descend from it; a delete needs the
 * ref present with the old value matching. The refusal reason for a non-fast-forward
 * update is exactly `non-fast-forward`.
 */
function applyPushCommand(
  store: Store,
  repo: Repo,
  command: PushCommand,
): { ok: true } | { ok: false; reason: string } {
  const current = repo.refs.get(command.ref);
  if (command.newOid === ZERO_OID) {
    if (current === undefined) return { ok: false, reason: 'remote ref does not exist' };
    if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
      return { ok: false, reason: 'non-fast-forward' };
    }
    repo.refs.delete(command.ref);
    repo.updatedAt = trialIso();
    return { ok: true };
  }
  const target = store.getObject(command.newOid);
  if (target === undefined) return { ok: false, reason: 'object not found' };
  if (command.oldOid === ZERO_OID) {
    if (current !== undefined) return { ok: false, reason: 'already exists' };
    repo.refs.set(command.ref, command.newOid);
    repo.updatedAt = trialIso();
    return { ok: true };
  }
  if (current === undefined) return { ok: false, reason: 'remote ref does not exist' };
  if (command.oldOid !== current) return { ok: false, reason: 'non-fast-forward' };
  const oldCommit = store.peelToCommit(current);
  const newCommit = store.peelToCommit(command.newOid);
  if (!store.isAncestor(oldCommit, newCommit)) return { ok: false, reason: 'non-fast-forward' };
  repo.refs.set(command.ref, command.newOid);
  repo.updatedAt = trialIso();
  return { ok: true };
}

/** Handle POST /{owner}/{repo}.git/git-receive-pack. */
function handleReceivePack(store: Store, repo: Repo, body: Buffer): GitResponse {
  const split = splitPushBody(body);
  const reportLines: string[] = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  if ('error' in split) {
    unpackOk = false;
    unpackDetail = split.error;
  } else {
    const updatesRef = split.commands.some((command) => command.newOid !== ZERO_OID);
    if (updatesRef || split.pack.length > 0) {
      if (split.pack.length === 0) {
        unpackOk = false;
        unpackDetail = 'unpacker error';
      } else if (split.pack.length < 32 || split.pack.subarray(0, 4).toString('ascii') !== 'PACK') {
        unpackOk = false;
        unpackDetail = 'unpacker error';
      } else {
        const checksum = verifyPackChecksum(split.pack);
        if (!checksum.ok) {
          unpackOk = false;
          unpackDetail = 'unpacker error';
        } else {
          try {
            const objects = readPack(split.pack, { resolveBase: (oid) => store.getObject(oid) });
            for (const [oid, object] of objects) {
              if (store.getObject(oid) === undefined) store.putObject(object.type, object.data);
            }
          } catch {
            unpackOk = false;
            unpackDetail = 'unpacker error';
          }
        }
      }
    }
    for (const command of split.commands) {
      if (!unpackOk) {
        reportLines.push(`ng ${command.ref} ${unpackDetail}`);
        continue;
      }
      const result = applyPushCommand(store, repo, command);
      reportLines.push(result.ok ? `ok ${command.ref}` : `ng ${command.ref} ${result.reason}`);
    }
  }
  const inner: Array<string | 'flush'> = [unpackOk ? 'unpack ok\n' : `unpack ${unpackDetail}\n`];
  for (const line of reportLines) inner.push(`${line}\n`);
  inner.push('flush');
  const innerBytes = encodePktLines(inner);
  // The report-status stream is pkt-lined inside sideband band 1 when the client
  // negotiated it, and sent bare otherwise; either way it ends with a flush.
  const sideband = !('error' in split) && split.capabilities.includes('side-band-64k');
  if (!sideband) {
    return { status: 200, contentType: 'application/x-git-receive-pack-result', body: innerBytes };
  }
  const outer: Buffer[] = [];
  for (let at = 0; at < innerBytes.length; at += SIDEBAND_CHUNK) {
    const chunk = innerBytes.subarray(at, Math.min(innerBytes.length, at + SIDEBAND_CHUNK));
    outer.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  outer.push(encodePktLines(['flush']));
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: Buffer.concat(outer) };
}

// -------------------------------------------------------------------------------------------
// routing
// -------------------------------------------------------------------------------------------

const GIT_PATH = /^\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

function notFound(message: string): GitResponse {
  return { status: 404, contentType: 'text/plain', body: Buffer.from(`${message}\n`) };
}

function unauthorized(): GitResponse {
  return { status: 401, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'Bad credentials' })) };
}

/**
 * Route a git request. Returns null when the path is not a git path, so the caller
 * can try the other surfaces. `token` is the server's own MAKEFUN_SHOP_TOKEN; when
 * it is empty (local runs without one) authentication is skipped.
 */
export function handleGit(
  store: Store,
  token: string,
  method: string,
  pathname: string,
  query: URLSearchParams,
  headers: Headers,
  body: Buffer,
): GitResponse | null {
  const match = GIT_PATH.exec(pathname);
  if (match === null) return null;
  const owner = match[1] as string;
  const name = match[2] as string;
  const route = match[3] as string;
  if (token !== '') {
    const presented = headers.get('authorization') ?? '';
    if (presented !== `Bearer ${token}`) return unauthorized();
  }
  if (owner !== VIEWER.login) return notFound('Not Found');
  const repo = store.getRepo(owner, name);
  if (repo === undefined) return notFound('Not Found');
  if (route === 'info/refs') {
    if (method !== 'GET') return { status: 405, contentType: 'text/plain', body: Buffer.from('Method Not Allowed\n') };
    const service = query.get('service');
    if (service === 'git-receive-pack') {
      return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body: v0Advertisement(store, repo, 'git-receive-pack') };
    }
    if (service === 'git-upload-pack') {
      const version2 = headers.get('git-protocol') === 'version=2';
      const advertisement = version2 ? v2Advertisement() : v0Advertisement(store, repo, 'git-upload-pack');
      return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: advertisement };
    }
    return notFound('Not Found');
  }
  if (method !== 'POST') return { status: 405, contentType: 'text/plain', body: Buffer.from('Method Not Allowed\n') };
  if (route === 'git-upload-pack') {
    const version2 = headers.get('git-protocol') === 'version=2';
    return handleUploadPack(store, repo, body, version2);
  }
  return handleReceivePack(store, repo, body);
}
