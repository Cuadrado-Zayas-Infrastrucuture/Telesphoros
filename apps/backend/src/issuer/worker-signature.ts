import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Spec 012 slice 2 (plan D1): the evaluation worker signs each job-capability request with a key only it and the issuer hold, and the issuer checks the
 * signature before it reads anything else. HMAC-SHA256 over a fixed text: a version tag, the method, the path, a millisecond timestamp, a random nonce and
 * the SHA-256 of the exact body bytes. The nonce makes each request unique; the issuer claims it in the database, so a copy is refused by every issuer task.
 *
 * Node's crypto only, so the worker can sign with this file without loading anything of the issuer's. Nothing here ever returns or logs the key, a
 * signature or a body.
 */
export const WORKER_CALLER = 'evaluation-worker';
/** How far the worker's clock may be from the issuer's, either way. Nonces are kept longer than this (migration 0057), so a replay is refused for as long as the timestamp is still accepted. */
export const MAX_CLOCK_SKEW_MS = 60_000;
export const MIN_WORKER_KEY_BYTES = 32;

const VERSION = 'telesphoros-worker-v1';
const NONCE = /^[A-Za-z0-9_-]{22,64}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{43}$/;
const TIMESTAMP = /^[0-9]{1,15}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export type WorkerSignatureHeaders = Record<'x-telesphoros-caller' | 'x-telesphoros-timestamp' | 'x-telesphoros-nonce' | 'x-telesphoros-signature', string>;
export type WorkerSignatureRefusal = 'unsigned' | 'unknown-caller' | 'malformed' | 'bad-signature' | 'stale';
export type WorkerSignatureResult = { ok: true; caller: string; nonce: string } | { ok: false; reason: WorkerSignatureRefusal };

interface Signed {
  method: string;
  path: string;
  body: Buffer;
}

const textToSign = (r: Signed, timestamp: string, nonce: string) =>
  [VERSION, r.method.toUpperCase(), r.path, timestamp, nonce, createHash('sha256').update(r.body).digest('hex')].join('\n');
const mac = (key: Buffer, text: string) => createHmac('sha256', key).update(text, 'utf8').digest();

/** The headers the worker sends. `timestamp` is milliseconds since the epoch on the worker's clock; `nonce` is for tests only. */
export function signWorkerRequest(input: Signed & { key: Buffer; timestamp: number; nonce?: string }): WorkerSignatureHeaders {
  const nonce = input.nonce ?? randomBytes(24).toString('base64url');
  const timestamp = String(Math.trunc(input.timestamp));
  return {
    'x-telesphoros-caller': WORKER_CALLER,
    'x-telesphoros-timestamp': timestamp,
    'x-telesphoros-nonce': nonce,
    'x-telesphoros-signature': mac(input.key, textToSign(input, timestamp, nonce)).toString('base64url'),
  };
}

/** The signature first (in constant time), then the clock: a request from someone without the key is always `bad-signature`, whatever its timestamp. */
export function verifyWorkerRequest(input: Signed & { key: Buffer; headers: Record<string, string | string[] | undefined>; now: number }): WorkerSignatureResult {
  const header = (name: keyof WorkerSignatureHeaders) => {
    const value = input.headers[name];
    return typeof value === 'string' ? value : undefined;
  };
  const caller = header('x-telesphoros-caller');
  const timestamp = header('x-telesphoros-timestamp');
  const nonce = header('x-telesphoros-nonce');
  const signature = header('x-telesphoros-signature');
  if (caller === undefined || timestamp === undefined || nonce === undefined || signature === undefined) return { ok: false, reason: 'unsigned' };
  if (caller !== WORKER_CALLER) return { ok: false, reason: 'unknown-caller' };
  if (!TIMESTAMP.test(timestamp) || !NONCE.test(nonce) || !SIGNATURE.test(signature)) return { ok: false, reason: 'malformed' };
  const expected = mac(input.key, textToSign(input, timestamp, nonce));
  const presented = Buffer.from(signature, 'base64url');
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return { ok: false, reason: 'bad-signature' };
  if (Math.abs(input.now - Number(timestamp)) > MAX_CLOCK_SKEW_MS) return { ok: false, reason: 'stale' };
  return { ok: true, caller, nonce };
}

/** Why a configured worker key cannot be used, or undefined if it can. Names the rule, never the value. */
export function workerKeyProblem(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return 'is required';
  if (!BASE64URL.test(value)) return 'must be base64url (A-Z, a-z, 0-9, - and _, no padding)';
  if (Buffer.from(value, 'base64url').length < MIN_WORKER_KEY_BYTES) return `must decode to at least ${MIN_WORKER_KEY_BYTES} bytes`;
  return undefined;
}
