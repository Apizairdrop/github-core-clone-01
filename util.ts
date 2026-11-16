// Shared helpers for the forge: hashing, ids, time and small HTTP conveniences.
// Everything here is deterministic: no wall clock and no unseeded randomness in a request
// path. Timestamps come from MAKEFUN_TRIAL_NOW (or a fixed epoch when it is absent), and
// request ids come from a counter, so a live run and its replay behave the same.

import { createHash } from 'node:crypto';
import type { ServerResponse } from 'node:http';

/** SHA-1 of a buffer, as lowercase hex. Git object ids are SHA-1. */
export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** Whether a string is a 40-character lowercase hex object id. */
export function isSha40(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/** Lowercase a value that should already be hex (a no-op guard for mixed case). */
export function lower(value: string): string {
  return value.toLowerCase();
}

/** The trial's fixed "now": MAKEFUN_TRIAL_NOW as RFC 3339 or epoch milliseconds. */
export function trialNow(): Date {
  const raw = (process.env.MAKEFUN_TRIAL_NOW ?? '').trim();
  if (raw !== '') {
    const asNumber = Number(raw);
    if (Number.isFinite(asNumber) && asNumber > 0) return new Date(asNumber);
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  // The scenario's day one, 2025-01-01T00:00:00Z, when the trial gives no time.
  return new Date(1_735_689_600_000);
}

/** The trial's fixed "now" as epoch seconds, for git author/committer lines. */
export function trialNowSec(): number {
  return Math.floor(trialNow().getTime() / 1000);
}

/** An ISO timestamp from the trial's fixed now. */
export function trialIso(): string {
  return trialNow().toISOString();
}

/** A base64 string of UTF-8 text (no line wrapping). */
export function b64encode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

/** Base64 for raw bytes (file contents), where the input is a Buffer, not text. */
export function b64encodeBuffer(data: Buffer): string {
  return data.toString('base64');
}

/** Decode base64 into raw bytes. */
export function b64decodeBuffer(content: string): Buffer {
  return Buffer.from(content.replace(/[\r\n\t ]+/g, ''), 'base64');
}

/** Decode base64 that may carry GitHub's line wrapping. */
export function b64decode(content: string): string {
  return Buffer.from(content.replace(/[\r\n\t ]+/g, ''), 'base64').toString('utf8');
}

/**
 * An opaque Relay-style global id: base64 of "forge:<kind>:<key>". The checks require
 * these to be stable across reads and not equal to the plain numeric id, which this
 * satisfies; decoding it recovers the kind and key for mutations that take one.
 */
export function globalId(kind: string, key: string): string {
  return b64encode(`forge:${kind}:${key}`);
}

/** Decode a global id made by globalId, or null when it is not one. */
export function parseGlobalId(value: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(value, 'base64').toString('utf8');
    const parts = text.split(':');
    if (parts.length < 3 || parts[0] !== 'forge') return null;
    return { kind: parts[1] as string, key: parts.slice(2).join(':') };
  } catch {
    return null;
  }
}

/** A request id for X-GitHub-Request-Id: a counter, deterministic inside one process. */
let requestCounter = 0;
export function nextRequestId(): string {
  requestCounter += 1;
  return `forge-req-${requestCounter}`;
}

/** The JSON content type every API reply carries. */
export const JSON_TYPE = 'application/json; charset=utf-8';

/**
 * Answer with a JSON body. `extra` headers sit beside the JSON ones; the request id
 * is added by the caller (the router) so every reply carries one.
 */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extra: Readonly<Record<string, string>> = {},
): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    ...extra,
  });
  res.end(text);
}

/** A JSON error body in GitHub's shape: {"message": "..."}. */
export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

/** Split a string on the first occurrence of a separator. */
export function splitFirst(text: string, sep: string): [string, string] {
  const at = text.indexOf(sep);
  if (at < 0) return [text, ''];
  return [text.slice(0, at), text.slice(at + sep.length)];
}
