import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, open, readFile, rm, writeFile } from 'node:fs/promises';

/**
 * Authenticated encryption for backups (format v2). Why this exists: the original scheme (AES-256-CBC with a passphrase)
 * keeps a backup confidential but cannot tell whether it was altered, and the manifest was not protected at all. A copy
 * held by another provider must be tamper-evident, so a provider (or anyone who reaches that bucket) cannot change a
 * backup, truncate it, reorder it, or edit its manifest without restore refusing it.
 *
 * File layout (all integers big-endian), scheme `aes-256-gcm-stream/1`:
 *
 *   header (37 bytes)  magic "TPBK" | version 0x02 | chunk size as a power of two (1 byte) | salt (16) | nonce prefix (7) | key id (8)
 *   then, repeated:    ciphertext of one chunk (up to the chunk size) | GCM tag (16)
 *
 * Every chunk is AES-256-GCM under a key derived (HKDF-SHA-256) from the master key and this backup's random salt.
 * The nonce is `nonce prefix | chunk counter (4) | final flag (1)`, so a chunk cannot be moved, repeated or dropped, and
 * only the last chunk carries the final flag, so a truncated file (or one with data appended) fails. The whole header is
 * the additional authenticated data of every chunk, so it cannot be altered either. An empty dump is still one
 * (empty, final) chunk, so "header only" is always a truncation.
 *
 * The manifest is sealed with HMAC-SHA-256 under a SEPARATE key derived from the same master key and salt.
 */
export const ENCRYPTION_SCHEME = 'aes-256-gcm-stream/1';

const MAGIC = Buffer.from('TPBK', 'ascii');
const VERSION = 2;
const TAG_BYTES = 16;
const SALT_BYTES = 16;
const NONCE_PREFIX_BYTES = 7;
const KEY_ID_BYTES = 8;
const HEADER_BYTES = MAGIC.length + 1 + 1 + SALT_BYTES + NONCE_PREFIX_BYTES + KEY_ID_BYTES;
const MIN_CHUNK_LOG2 = 6; // 64 bytes: tests only
const MAX_CHUNK_LOG2 = 26; // 64 MiB
export const DEFAULT_CHUNK_LOG2 = 20; // 1 MiB: bounded memory however large the dump
const MAX_CHUNKS = 2 ** 32 - 1;

export type CryptoErrorCode = 'bad-key-file' | 'not-a-backup' | 'wrong-key' | 'tampered' | 'truncated';

const MESSAGES: Record<CryptoErrorCode, string> = {
  'bad-key-file': 'The key file must contain exactly 64 hexadecimal characters (a random 32-byte key).',
  'not-a-backup': 'This is not a Telesphoros encrypted backup, or it is a version this tool does not read.',
  'wrong-key': 'This backup was encrypted with a different key.',
  tampered: 'The backup is damaged or has been altered: authentication failed.',
  truncated: 'The backup is incomplete.',
};

/** Always one of the fixed messages above: never a byte, a key or a path. */
export class BackupCryptoError extends Error {
  constructor(readonly code: CryptoErrorCode) {
    super(MESSAGES[code]);
    this.name = 'BackupCryptoError';
  }
}

export interface EncryptionInfo {
  scheme: typeof ENCRYPTION_SCHEME;
  /** Identifies the key (not secret, not derived from the salt): tells an operator which key file a backup needs. */
  keyId: string;
  /** Hex. Also in the file header; restore refuses a manifest whose salt differs. */
  salt: string;
  chunkSize: number;
}

const derive = (master: Buffer, salt: Buffer, info: string, length: number): Buffer => Buffer.from(hkdfSync('sha256', master, salt, info, length));
const keyIdOf = (master: Buffer): Buffer => derive(master, Buffer.alloc(0), 'telesphoros-backup/key-id/1', KEY_ID_BYTES);
const encKeyOf = (master: Buffer, salt: Buffer): Buffer => derive(master, salt, 'telesphoros-backup/enc/1', 32);
const macKeyOf = (master: Buffer, salt: Buffer): Buffer => derive(master, salt, 'telesphoros-backup/manifest-mac/1', 32);

// ---------------------------------------------------------------------------------------------------- the key file

/** A 32-byte key as 64 hex characters (whitespace around it is ignored). Refuses anything that does not look random. */
export async function readKeyFile(path: string): Promise<Buffer> {
  const text = (await readFile(path, 'utf8')).trim();
  if (!/^[0-9a-fA-F]{64}$/.test(text)) throw new BackupCryptoError('bad-key-file');
  const key = Buffer.from(text, 'hex');
  if (new Set(key).size < 8) throw new BackupCryptoError('bad-key-file'); // all zeros, a repeated byte: not a random key
  return key;
}

/** Writes a new random key, owner-only, and never overwrites an existing file (losing a key loses every backup made with it). */
export async function generateKeyFile(path: string): Promise<{ keyId: string }> {
  const key = randomBytes(32);
  await writeFile(path, `${key.toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
  await chmod(path, 0o600);
  return { keyId: keyIdOf(key).toString('hex') };
}

export const keyIdHex = (master: Buffer): string => keyIdOf(master).toString('hex');

// ------------------------------------------------------------------------------------------------ chunk plumbing

async function* rechunk(source: AsyncIterable<Buffer>, size: number): AsyncGenerator<Buffer> {
  let buffered: Buffer[] = [];
  let length = 0;
  for await (const piece of source) {
    buffered.push(piece);
    length += piece.length;
    while (length >= size) {
      const all = Buffer.concat(buffered);
      yield all.subarray(0, size);
      const rest = all.subarray(size);
      buffered = rest.length > 0 ? [rest] : [];
      length = rest.length;
    }
  }
  if (length > 0) yield Buffer.concat(buffered);
}

/** Tells each item whether it is the last one, by reading one ahead. */
async function* withLast<T>(source: AsyncIterable<T>): AsyncGenerator<{ value: T; last: boolean }> {
  let previous: T | undefined;
  let has = false;
  for await (const value of source) {
    if (has) yield { value: previous as T, last: false };
    previous = value;
    has = true;
  }
  if (has) yield { value: previous as T, last: true };
}

function nonceFor(prefix: Buffer, counter: number, last: boolean): Buffer {
  const nonce = Buffer.alloc(12);
  prefix.copy(nonce, 0);
  nonce.writeUInt32BE(counter, NONCE_PREFIX_BYTES);
  nonce[11] = last ? 1 : 0;
  return nonce;
}

interface Header {
  chunkLog2: number;
  salt: Buffer;
  noncePrefix: Buffer;
  keyId: Buffer;
  raw: Buffer;
}

function parseHeader(raw: Buffer): Header {
  if (raw.length < HEADER_BYTES || !raw.subarray(0, MAGIC.length).equals(MAGIC) || raw[MAGIC.length] !== VERSION) throw new BackupCryptoError('not-a-backup');
  const chunkLog2 = raw[MAGIC.length + 1]!;
  if (chunkLog2 < MIN_CHUNK_LOG2 || chunkLog2 > MAX_CHUNK_LOG2) throw new BackupCryptoError('not-a-backup');
  const saltAt = MAGIC.length + 2;
  const prefixAt = saltAt + SALT_BYTES;
  const keyIdAt = prefixAt + NONCE_PREFIX_BYTES;
  const salt = raw.subarray(saltAt, prefixAt);
  const noncePrefix = raw.subarray(prefixAt, keyIdAt);
  const keyId = raw.subarray(keyIdAt, keyIdAt + KEY_ID_BYTES);
  return { chunkLog2, salt, noncePrefix, keyId, raw: raw.subarray(0, HEADER_BYTES) };
}

async function readHeaderBytes(path: string): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(HEADER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEADER_BYTES, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** The salt and key id in a backup file's header, for cross-checking the manifest. Throws not-a-backup if it is not one. */
export async function readEncryptionHeader(path: string): Promise<{ salt: string; keyId: string; chunkSize: number }> {
  const header = parseHeader(await readHeaderBytes(path));
  return { salt: header.salt.toString('hex'), keyId: header.keyId.toString('hex'), chunkSize: 2 ** header.chunkLog2 };
}

// ------------------------------------------------------------------------------------------------ encrypt / decrypt

export interface EncryptOptions {
  /** Power of two. Default 20 (1 MiB). Smaller values exist for tests. */
  chunkLog2?: number;
  /** Test seams: fixed randomness for known-answer tests. Never used in production. */
  salt?: Buffer;
  noncePrefix?: Buffer;
}

/** Encrypts `input` to a new file `output` (owner-only; refuses to overwrite). On any failure the partial output is removed. */
export async function encryptFile(input: string, output: string, master: Buffer, options: EncryptOptions = {}): Promise<EncryptionInfo> {
  const chunkLog2 = options.chunkLog2 ?? DEFAULT_CHUNK_LOG2;
  if (!Number.isInteger(chunkLog2) || chunkLog2 < MIN_CHUNK_LOG2 || chunkLog2 > MAX_CHUNK_LOG2) throw new RangeError('chunkLog2 out of range');
  const chunkSize = 2 ** chunkLog2;
  const salt = options.salt ?? randomBytes(SALT_BYTES);
  const noncePrefix = options.noncePrefix ?? randomBytes(NONCE_PREFIX_BYTES);
  const header = Buffer.concat([MAGIC, Buffer.from([VERSION, chunkLog2]), salt, noncePrefix, keyIdOf(master)]);
  const encKey = encKeyOf(master, salt);

  const out = await open(output, 'wx', 0o600);
  let counter = 0;
  try {
    await out.write(header);
    const seal = async (plain: Buffer, last: boolean) => {
      if (counter >= MAX_CHUNKS) throw new RangeError('backup too large for this format');
      const cipher = createCipheriv('aes-256-gcm', encKey, nonceFor(noncePrefix, counter, last), { authTagLength: TAG_BYTES });
      cipher.setAAD(header);
      const body = Buffer.concat([cipher.update(plain), cipher.final()]);
      await out.write(Buffer.concat([body, cipher.getAuthTag()]));
      counter += 1;
    };
    for await (const { value, last } of withLast(rechunk(createReadStream(input, { highWaterMark: chunkSize }), chunkSize))) await seal(value, last);
    if (counter === 0) await seal(Buffer.alloc(0), true); // an empty dump is one empty final chunk, so "header only" is a truncation
    await out.close();
  } catch (error) {
    await out.close().catch(() => undefined); // intentional: the original error is the one worth reporting
    await rm(output, { force: true });
    throw error;
  }
  return { scheme: ENCRYPTION_SCHEME, keyId: keyIdOf(master).toString('hex'), salt: salt.toString('hex'), chunkSize };
}

/** Decrypts and AUTHENTICATES `input` into a new file `output`. Nothing is kept if any chunk fails: the partial output is removed. */
export async function decryptFile(input: string, output: string, master: Buffer): Promise<void> {
  const header = parseHeader(await readHeaderBytes(input));
  if (!timingSafeEqual(header.keyId, keyIdOf(master))) throw new BackupCryptoError('wrong-key');
  const chunkSize = 2 ** header.chunkLog2;
  const encKey = encKeyOf(master, header.salt);

  const out = await open(output, 'wx', 0o600);
  try {
    const ciphertext = createReadStream(input, { start: HEADER_BYTES, highWaterMark: chunkSize + TAG_BYTES });
    let counter = 0;
    for await (const { value, last } of withLast(rechunk(ciphertext, chunkSize + TAG_BYTES))) {
      if (value.length < TAG_BYTES) throw new BackupCryptoError(last ? 'truncated' : 'tampered');
      const decipher = createDecipheriv('aes-256-gcm', encKey, nonceFor(header.noncePrefix, counter, last), { authTagLength: TAG_BYTES });
      decipher.setAAD(header.raw);
      decipher.setAuthTag(value.subarray(value.length - TAG_BYTES));
      let plain: Buffer;
      try {
        plain = Buffer.concat([decipher.update(value.subarray(0, value.length - TAG_BYTES)), decipher.final()]);
      } catch {
        // Authentication failed: a changed, moved, repeated or dropped chunk, a changed header, or a truncated file all land here.
        throw new BackupCryptoError('tampered');
      }
      await out.write(plain);
      counter += 1;
    }
    if (counter === 0) throw new BackupCryptoError('truncated'); // a header and nothing after it
    await out.close();
  } catch (error) {
    await out.close().catch(() => undefined); // intentional: the original error is the one worth reporting
    await rm(output, { force: true });
    throw error;
  }
}

// ------------------------------------------------------------------------------------------------------ manifest MAC

/** Canonical text of a value: keys sorted at every level, no whitespace. The manifest holds only strings, integers, booleans, null, arrays and objects. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

/** HMAC-SHA-256 of the manifest with its own `mac` field left out, keyed from the master key and the backup's salt. */
export function manifestMac(manifest: object, master: Buffer, saltHex: string): string {
  const { mac: _mac, ...body } = manifest as { mac?: unknown };
  void _mac;
  return createHmac('sha256', macKeyOf(master, Buffer.from(saltHex, 'hex'))).update(stableStringify(body)).digest('hex');
}

export function verifyManifestMac(manifest: object, master: Buffer, saltHex: string): boolean {
  const { mac } = manifest as { mac?: unknown };
  if (typeof mac !== 'string' || !/^[0-9a-f]{64}$/.test(mac) || !/^[0-9a-f]{32}$/.test(saltHex)) return false;
  return timingSafeEqual(Buffer.from(mac, 'hex'), Buffer.from(manifestMac(manifest, master, saltHex), 'hex'));
}
