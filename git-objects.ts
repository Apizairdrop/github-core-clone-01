// Git objects, packfiles and the pkt-line framing, in pure Node.js.
//
// This is the forge's git core: content-addressed objects (blob/tree/commit/tag),
// the smart-HTTP packet framing, and packfile read/write. No git binary is involved;
// every byte is built and parsed here. Objects are SHA-1, as the suite speaks.

import { inflateSync, deflateSync } from 'node:zlib';
import { sha1Hex } from './util.ts';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);

/** The id of an object: sha1 of "<type> <size>\0<data>". */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

/** The type code a packfile entry carries. */
function typeCode(type: GitObjectType): number {
  if (type === 'commit') return 1;
  if (type === 'tree') return 2;
  if (type === 'blob') return 3;
  return 4; // tag
}

function typeOfCode(code: number): GitObjectType {
  if (code === 1) return 'commit';
  if (code === 2) return 'tree';
  if (code === 3) return 'blob';
  if (code === 4) return 'tag';
  throw new Error(`unknown git object type code ${code}`);
}

// ---------------------------------------------------------------------------------------------
// trees, commits, tags
// ---------------------------------------------------------------------------------------------

export interface TreeEntry {
  mode: string; // '100644' for a file, '40000' for a directory
  name: string;
  oid: string;
}

/** Parse a tree object's entries (mode SP name NUL 20-byte oid, in order). */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    if (space < 0) throw new Error('malformed tree: no space after mode');
    const mode = data.subarray(at, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0) throw new Error('malformed tree: no NUL after name');
    const name = data.subarray(space + 1, nul).toString('utf8');
    if (nul + 21 > data.length) throw new Error('malformed tree: truncated oid');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    at = nul + 21;
  }
  return entries;
}

/** Build a tree object from entries (sorted by name, git's order). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object into its headers and message. */
export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  const parents: string[] = [];
  let tree = '';
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** Build a commit object. The message is stored with one trailing newline, git's way. */
export function buildCommit(fields: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines: string[] = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author}`);
  lines.push(`committer ${fields.committer}`);
  const message = fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8');
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

/** Parse an annotated tag object. */
export function parseTag(data: Buffer): TagView {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

/** Build an annotated tag object. */
export function buildTag(fields: {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}): Buffer {
  const message = fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`;
  return Buffer.from(
    `object ${fields.object}\ntype ${fields.type}\ntag ${fields.tag}\ntagger ${fields.tagger}\n\n${message}`,
    'utf8',
  );
}

// ---------------------------------------------------------------------------------------------
// pkt-line framing
// ---------------------------------------------------------------------------------------------

/** One pkt-line: the 4-hex length prefix plus the payload (length counts the prefix). */
export function encodePktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  if (length > 65520) throw new Error(`pkt-line of ${length} bytes exceeds the 65520 limit`);
  const head = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

/** Encode several lines (strings, Buffers, or the markers 'flush' / 'delim'). */
export function encodePktLines(lines: readonly (string | Buffer | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(Buffer.from('0000', 'ascii'));
    else if (line === 'delim') parts.push(Buffer.from('0001', 'ascii'));
    else parts.push(encodePktLine(line));
  }
  return Buffer.concat(parts);
}

/** A flush pkt-line (0000). */
export function pktLineFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

/** A delim pkt-line (0001). */
export function pktLineDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export type PktKind = 'data' | 'flush' | 'delim' | 'response-end';

export interface PktLine {
  kind: PktKind;
  payload: Buffer;
}

/**
 * Decode every pkt-line in a complete buffer. Throws on a truncated or malformed
 * stream; a trailing partial line is an error, not a silent cut.
 */
export function decodePktLines(bytes: Buffer): PktLine[] {
  const lines: PktLine[] = [];
  let at = 0;
  while (at < bytes.length) {
    if (at + 4 > bytes.length) throw new Error('truncated pkt-line length');
    const length = parseInt(bytes.subarray(at, at + 4).toString('ascii'), 16);
    if (Number.isNaN(length)) throw new Error('pkt-line length is not hex');
    if (length === 0) {
      lines.push({ kind: 'flush', payload: Buffer.alloc(0) });
      at += 4;
      continue;
    }
    if (length === 1) {
      lines.push({ kind: 'delim', payload: Buffer.alloc(0) });
      at += 4;
      continue;
    }
    if (length === 2) {
      lines.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      at += 4;
      continue;
    }
    if (length < 4 || at + length > bytes.length) throw new Error('pkt-line length out of range');
    lines.push({ kind: 'data', payload: Buffer.from(bytes.subarray(at + 4, at + length)) });
    at += length;
  }
  return lines;
}

/** A streaming pkt-line decoder: feed chunks, pull whole lines out. */
export class PktLineDecoder {
  #buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): void {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
  }

  next(): PktLine | null {
    if (this.#buffer.length < 4) return null;
    const length = parseInt(this.#buffer.subarray(0, 4).toString('ascii'), 16);
    if (Number.isNaN(length)) throw new Error('pkt-line length is not hex');
    if (length === 0) {
      this.#buffer = this.#buffer.subarray(4);
      return { kind: 'flush', payload: Buffer.alloc(0) };
    }
    if (length === 1) {
      this.#buffer = this.#buffer.subarray(4);
      return { kind: 'delim', payload: Buffer.alloc(0) };
    }
    if (length === 2) {
      this.#buffer = this.#buffer.subarray(4);
      return { kind: 'response-end', payload: Buffer.alloc(0) };
    }
    if (length < 4 || this.#buffer.length < length) return null;
    const payload = Buffer.from(this.#buffer.subarray(4, length));
    this.#buffer = this.#buffer.subarray(length);
    return { kind: 'data', payload };
  }

  /** Bytes not yet consumed as a line (the pack that follows a flush). */
  rest(): Buffer {
    return this.#buffer;
  }
}

// ---------------------------------------------------------------------------------------------
// packfiles
// ---------------------------------------------------------------------------------------------

/** Read a variable-length integer: 7 bits per byte, little-endian groups, MSB continues. */
function readVarint(bytes: Buffer, at: number): { value: number; next: number } {
  let value = bytes[at] as number;
  let shift = 0;
  let pos = at + 1;
  while ((value & 0x80) !== 0) {
    value = (value & 0x7f) | ((bytes[pos] as number) << (shift + 7));
    shift += 7;
    pos += 1;
  }
  return { value, next: pos };
}

/** Apply a delta's instructions to its base, producing the target object. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let at = 0;
  const sourceSize = readVarint(delta, at);
  at = sourceSize.next;
  if (sourceSize.value !== base.length) throw new Error('delta source size does not match the base');
  const targetSize = readVarint(delta, at);
  at = targetSize.next;
  const out: Buffer[] = [];
  let produced = 0;
  while (at < delta.length) {
    const op = delta[at] as number;
    at += 1;
    if ((op & 0x80) !== 0) {
      // Copy from the base: the low bits name which offset/size bytes follow.
      let offset = 0;
      let size = 0;
      if ((op & 0x01) !== 0) offset = delta[at] as number, at += 1;
      if ((op & 0x02) !== 0) offset |= (delta[at] as number) << 8, at += 1;
      if ((op & 0x04) !== 0) offset |= (delta[at] as number) << 16, at += 1;
      if ((op & 0x08) !== 0) offset |= (delta[at] as number) << 24, at += 1;
      if ((op & 0x10) !== 0) size = delta[at] as number, at += 1;
      if ((op & 0x20) !== 0) size |= (delta[at] as number) << 8, at += 1;
      if ((op & 0x40) !== 0) size |= (delta[at] as number) << 16, at += 1;
      if (size === 0) size = 0x10000;
      if (offset + size > base.length) throw new Error('delta copy runs past the base');
      out.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op !== 0) {
      // Insert literal bytes from the delta itself.
      if (at + op > delta.length) throw new Error('delta insert runs past the delta');
      out.push(delta.subarray(at, at + op));
      produced += op;
      at += op;
    } else {
      throw new Error('delta has a zero instruction byte');
    }
  }
  if (produced !== targetSize.value) throw new Error('delta target size does not match the instructions');
  return Buffer.concat(out);
}

/**
 * Read a packfile into its objects. Handles plain objects and OFS/REF deltas; a delta
 * whose base is not in the pack is resolved from `resolveBase` (the server's store).
 */
export function readPack(
  pack: Buffer,
  options: { resolveBase?: (oid: string) => GitObject | undefined } = {},
): Map<string, GitObject> {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  // The trailer is the last 20 bytes; entries live between the header and it.
  const end = pack.length - 20;
  const expected = sha1Hex(pack.subarray(0, end));
  const trailer = pack.subarray(end).toString('hex');
  if (expected !== trailer) throw new Error('pack trailer does not match its bytes');

  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, { type: GitObjectType; data: Buffer; oid: string }>();
  let at = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = at;
    const first = pack[at] as number;
    at += 1;
    const typeCodeValue = (first >> 4) & 0x07;
    let size = first & 0x0f;
    let shift = 4;
    let byte = first;
    while ((byte & 0x80) !== 0) {
      byte = pack[at] as number;
      at += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    if (typeCodeValue === 6) {
      // OFS_DELTA: the base sits a negative offset behind this entry.
      let offsetByte = pack[at] as number;
      at += 1;
      let baseOffset = offsetByte & 0x7f;
      while ((offsetByte & 0x80) !== 0) {
        offsetByte = pack[at] as number;
        at += 1;
        baseOffset = ((baseOffset + 1) << 7) | (offsetByte & 0x7f);
      }
      const baseEntryOffset = entryOffset - baseOffset;
      const inflated = inflateSync(pack.subarray(at));
      const consumed = packInflatedLength(pack, at);
      at += consumed;
      const base = byOffset.get(baseEntryOffset);
      if (base === undefined) throw new Error('ofs-delta base is not an earlier pack entry');
      const data = applyDelta(base.data, inflated);
      const oid = hashObject(base.type, data);
      const object: GitObject = { type: base.type, data };
      objects.set(oid, object);
      byOffset.set(entryOffset, { ...object, oid });
    } else if (typeCodeValue === 7) {
      // REF_DELTA: the base is named by its object id.
      const baseOid = pack.subarray(at, at + 20).toString('hex');
      at += 20;
      const inflated = inflateSync(pack.subarray(at));
      at += packInflatedLength(pack, at);
      const base = objects.get(baseOid) ?? options.resolveBase?.(baseOid);
      if (base === undefined) throw new Error(`ref-delta base ${baseOid} is not available`);
      const data = applyDelta(base.data, inflated);
      const oid = hashObject(base.type, data);
      const object: GitObject = { type: base.type, data };
      objects.set(oid, object);
      byOffset.set(entryOffset, { ...object, oid });
    } else {
      const type = typeOfCode(typeCodeValue);
      const inflated = inflateSync(pack.subarray(at));
      at += packInflatedLength(pack, at);
      if (inflated.length !== size) throw new Error('pack entry size does not match its header');
      const oid = hashObject(type, inflated);
      const object: GitObject = { type, data: inflated };
      objects.set(oid, object);
      byOffset.set(entryOffset, { ...object, oid });
    }
  }
  return objects;
}

/** How many bytes a zlib stream starting at `at` occupies (its end, found by inflate). */
function packInflatedLength(pack: Buffer, at: number): number {
  // Inflate with a window that reports how much input was consumed: re-inflate a
  // growing prefix is wasteful, so instead inflate once and measure via the stream's
  // unused tail. Node's inflateSync returns only the output, so find the end by
  // scanning: a zlib stream ends at the first byte after its final block, which
  // inflateSync on a truncated slice rejects. Binary-search the smallest prefix
  // that inflates cleanly.
  let low = at;
  let high = pack.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    try {
      inflateSync(pack.subarray(at, mid));
      high = mid;
    } catch {
      low = mid + 1;
    }
  }
  return low - at;
}

/**
 * Build a packfile (version 2) from plain objects, no deltas. Entries are written in
 * oid order so the pack is deterministic; the trailer is the SHA-1 of the bytes before it.
 */
export function writePack(objects: Iterable<GitObject>): Buffer {
  // Hash each object once, then sort by id: hashing inside the comparator would
  // recompute a SHA-1 per comparison, which dominates pack time on large packs.
  const list = [...objects].map((object) => ({ oid: hashObject(object.type, object.data), object }));
  list.sort((a, b) => (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const { object } of list) {
    const code = typeCode(object.type);
    const size = object.data.length;
    const headerBytes: number[] = [];
    let first = (code << 4) | (size & 0x0f);
    let rest = size >> 4;
    if (rest !== 0) first |= 0x80;
    headerBytes.push(first);
    while (rest !== 0) {
      let byte = rest & 0x7f;
      rest >>= 7;
      if (rest !== 0) byte |= 0x80;
      headerBytes.push(byte);
    }
    parts.push(Buffer.from(headerBytes));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = Buffer.from(sha1Hex(body), 'hex');
  return Buffer.concat([body, trailer]);
}

/** Verify a pack's trailer checksum. */
export function verifyPackChecksum(pack: Buffer): { ok: boolean; expected: string; actual: string } {
  if (pack.length < 20) return { ok: false, expected: '', actual: '' };
  const expected = sha1Hex(pack.subarray(0, pack.length - 20));
  const actual = pack.subarray(pack.length - 20).toString('hex');
  return { ok: expected === actual, expected, actual };
}

// ---------------------------------------------------------------------------------------------
// reachability and trees
// ---------------------------------------------------------------------------------------------

export type ObjectLookup = (oid: string) => GitObject | undefined;

/**
 * Every object id reachable from `roots`: a commit reaches its tree and parents, a
 * tree reaches its entries, a tag reaches its target. Gitlinks (mode 160000) are skipped.
 * Throws when a reachable object is missing.
 */
export function collectReachable(roots: readonly string[], lookup: ObjectLookup): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid) || oid === ZERO_OID) continue;
    const object = lookup(oid);
    if (object === undefined) throw new Error(`missing object ${oid}`);
    seen.add(oid);
    if (object.type === 'commit') {
      const view = parseCommit(object.data);
      stack.push(view.tree);
      for (const parent of view.parents) stack.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        stack.push(entry.oid);
      }
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return seen;
}

/**
 * The objects a client already holds, from its haves: like collectReachable, but a
 * commit named in `shallow` contributes itself, its tree and its blobs, never its
 * parents — the client holds a shallow boundary, not the history behind it.
 */
export function collectHeld(haves: readonly string[], shallow: ReadonlySet<string>, lookup: ObjectLookup): Set<string> {
  const seen = new Set<string>();
  const stack: Array<{ oid: string; stop: boolean }> = haves.map((oid) => ({ oid, stop: false }));
  while (stack.length > 0) {
    const { oid, stop } = stack.pop() as { oid: string; stop: boolean };
    if (seen.has(oid) || oid === ZERO_OID) continue;
    const object = lookup(oid);
    if (object === undefined) continue; // a have the server never saw is not held here
    seen.add(oid);
    if (object.type === 'commit') {
      const view = parseCommit(object.data);
      stack.push({ oid: view.tree, stop: false });
      if (!stop && !shallow.has(oid)) {
        for (const parent of view.parents) stack.push({ oid: parent, stop: false });
      }
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        stack.push({ oid: entry.oid, stop: false });
      }
    } else if (object.type === 'tag') {
      stack.push({ oid: parseTag(object.data).object, stop: false });
    }
  }
  return seen;
}

/**
 * Build the nested trees for a flat path -> blob map, storing every tree object
 * through `put`. Returns the root tree's oid. Paths are slash-separated, no leading
 * slash; an empty map yields the empty tree.
 */
export function buildTreeFromFiles(
  files: ReadonlyMap<string, string>,
  put: (type: GitObjectType, data: Buffer) => string,
): string {
  // Group paths by their first segment, recursing into directories. `prefix` is the
  // full path of this level, so a direct entry can be looked up in `files` (whose
  // keys are full paths) while `paths` holds the remainders below this level.
  const buildLevel = (prefix: string, paths: readonly string[]): string => {
    const entries: TreeEntry[] = [];
    const dirs = new Map<string, string[]>();
    const direct: string[] = [];
    for (const path of paths) {
      const slash = path.indexOf('/');
      if (slash < 0) direct.push(path);
      else {
        const dir = path.slice(0, slash);
        const rest = path.slice(slash + 1);
        const list = dirs.get(dir) ?? [];
        list.push(rest);
        dirs.set(dir, list);
      }
    }
    for (const path of direct) {
      const full = prefix === '' ? path : `${prefix}/${path}`;
      const oid = files.get(full);
      if (oid === undefined) throw new Error(`buildTreeFromFiles: no blob for ${full}`);
      entries.push({ mode: '100644', name: path, oid });
    }
    for (const [dir, sub] of [...dirs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const subPrefix = prefix === '' ? dir : `${prefix}/${dir}`;
      entries.push({ mode: '40000', name: dir, oid: buildLevel(subPrefix, sub) });
    }
    const data = buildTree(entries);
    return put('tree', data);
  };
  if (files.size === 0) {
    const data = buildTree([]);
    return put('tree', data);
  }
  return buildLevel('', [...files.keys()]);
}

/** Flatten a tree (by oid) into path -> {oid, mode}, walking nested trees. */
export function flattenTree(rootOid: string, lookup: ObjectLookup): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (treeOid: string, prefix: string): void => {
    const object = lookup(treeOid);
    if (object === undefined || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else if (entry.mode !== '160000') out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(rootOid, '');
  return out;
}

/** The blob oid and bytes at `path` in the tree of `commitOid`, or null. */
export function readPath(
  commitOid: string,
  path: string,
  lookup: ObjectLookup,
): { oid: string; data: Buffer } | null {
  const commit = lookup(commitOid);
  if (commit === undefined || commit.type !== 'commit') return null;
  const tree = parseCommit(commit.data).tree;
  const flat = flattenTree(tree, lookup);
  const entry = flat.get(path);
  if (entry === undefined) return null;
  const blob = lookup(entry.oid);
  if (blob === undefined || blob.type !== 'blob') return null;
  return { oid: entry.oid, data: blob.data };
}

/** The entries directly under `dirPath` in the tree of `commitOid` ('' is the root). */
export function listDir(
  commitOid: string,
  dirPath: string,
  lookup: ObjectLookup,
): Array<{ name: string; path: string; oid: string; mode: string }> {
  const commit = lookup(commitOid);
  if (commit === undefined || commit.type !== 'commit') return [];
  let treeOid = parseCommit(commit.data).tree;
  if (dirPath !== '') {
    const segments = dirPath.split('/').filter((s) => s !== '');
    for (const segment of segments) {
      const object = lookup(treeOid);
      if (object === undefined || object.type !== 'tree') return [];
      const entry = parseTree(object.data).find((candidate) => candidate.name === segment);
      if (entry === undefined || entry.mode !== '40000') return [];
      treeOid = entry.oid;
    }
  }
  const object = lookup(treeOid);
  if (object === undefined || object.type !== 'tree') return [];
  return parseTree(object.data).map((entry) => ({
    name: entry.name,
    path: dirPath === '' ? entry.name : `${dirPath}/${entry.name}`,
    oid: entry.oid,
    mode: entry.mode,
  }));
}

/**
 * The file-level difference between two trees: added, modified and removed paths.
 * Each entry carries a line diff so callers can report additions and deletions.
 */
export interface FileDiff {
  path: string;
  status: 'added' | 'modified' | 'removed';
  oldOid: string | null;
  newOid: string | null;
  additions: number;
  deletions: number;
}

export function diffTrees(baseTree: string, headTree: string, lookup: ObjectLookup): FileDiff[] {
  const base = flattenTree(baseTree, lookup);
  const head = flattenTree(headTree, lookup);
  const paths = new Set([...base.keys(), ...head.keys()]);
  const diffs: FileDiff[] = [];
  for (const path of [...paths].sort()) {
    const from = base.get(path);
    const to = head.get(path);
    if (from !== undefined && to !== undefined && from.oid === to.oid) continue;
    if (from === undefined && to !== undefined) {
      const blob = lookup(to.oid);
      const lines = blob === undefined ? 0 : countLines(blob.data);
      diffs.push({ path, status: 'added', oldOid: null, newOid: to.oid, additions: lines, deletions: 0 });
    } else if (from !== undefined && to === undefined) {
      const blob = lookup(from.oid);
      const lines = blob === undefined ? 0 : countLines(blob.data);
      diffs.push({ path, status: 'removed', oldOid: from.oid, newOid: null, additions: 0, deletions: lines });
    } else if (from !== undefined && to !== undefined) {
      const oldBlob = lookup(from.oid);
      const newBlob = lookup(to.oid);
      const { additions, deletions } = lineDiff(
        oldBlob === undefined ? '' : oldBlob.data.toString('utf8'),
        newBlob === undefined ? '' : newBlob.data.toString('utf8'),
      );
      diffs.push({ path, status: 'modified', oldOid: from.oid, newOid: to.oid, additions, deletions });
    }
  }
  return diffs;
}

/** How many lines a buffer holds (a trailing newline does not start a new line). */
export function countLines(data: Buffer): number {
  const text = data.toString('utf8');
  if (text === '') return 0;
  const lines = text.split('\n');
  return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
}

/**
 * A line diff between two texts: the count of added and removed lines, by longest
 * common subsequence. The files the suite diffs are small, so the O(n*m) table is fine.
 */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  if (oldLines.length > 0 && oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newLines.length > 0 && newLines[newLines.length - 1] === '') newLines.pop();
  const n = oldLines.length;
  const m = newLines.length;
  // LCS lengths, one row at a time.
  let prev = new Array<number>(m + 1).fill(0);
  let curr = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      curr[j] = oldLines[i - 1] === newLines[j - 1] ? (prev[j - 1] as number) + 1 : Math.max(prev[j] as number, curr[j - 1] as number);
    }
    const swap = prev;
    prev = curr;
    curr = swap;
    curr.fill(0);
  }
  const common = prev[m] as number;
  return { additions: m - common, deletions: n - common };
}
