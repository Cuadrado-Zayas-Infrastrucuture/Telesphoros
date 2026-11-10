import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import type { KnowledgeFile } from '@telesphoros/cpic-schema';

/**
 * Two-person sign-off for real knowledge (audit CLIN-01). A reviewed real file loads under the production rules only with valid signatures from at
 * least two distinct signers whose public keys are configured where the process runs (`KNOWLEDGE_SIGNER_KEYS`), never read from the repository:
 * write access to the knowledge files is then not enough to sign them.
 */
export type SignerKeys = ReadonlyMap<string, KeyObject>;

export const REQUIRED_SIGNERS = 2;
const MAX_SIGNERS = 20;
const KEY_ID = /^[a-z0-9][a-z0-9-]{1,62}$/;

export class SignerKeysError extends Error {}

/**
 * The exact bytes a signer signs: a fixed tag (so the signature means nothing elsewhere), the file id (so it cannot be moved onto another file) and the
 * file's `contentSha256` (so any edit to the content voids it).
 */
export function signingMessage(fileId: string, contentSha256: string): Buffer {
  return Buffer.from(`telesphoros-knowledge/1\n${fileId}\n${contentSha256}`, 'utf8');
}

/**
 * What makes two entries the same key: the public point itself, not the text or bytes it arrived in. One key can be written more than one way (point
 * compressed or not, or as the private half it is derived from), so comparing the encodings would let one key pass as two.
 */
function keyIdentity(key: KeyObject): string {
  const { kty, crv, x, y, n, e } = key.export({ format: 'jwk' });
  return JSON.stringify([kty, crv, x, y, n, e]);
}

/**
 * `KNOWLEDGE_SIGNER_KEYS`: a JSON object of key id to SPKI PEM public key, P-256 only, each signer with a key of their own. Errors name the key id,
 * never the key.
 */
export function parseSignerKeys(json: string | undefined): SignerKeys {
  if (json === undefined || json.trim() === '') return new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    // intentional: JSON.parse messages quote the input
    throw new SignerKeysError('KNOWLEDGE_SIGNER_KEYS is not valid JSON.');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new SignerKeysError('KNOWLEDGE_SIGNER_KEYS must be a JSON object of key id to PEM public key.');
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length > MAX_SIGNERS) throw new SignerKeysError(`KNOWLEDGE_SIGNER_KEYS lists more than ${MAX_SIGNERS} signers.`);
  const keys = new Map<string, KeyObject>();
  const holders = new Map<string, string>();
  for (const [keyId, pem] of entries) {
    if (!KEY_ID.test(keyId)) throw new SignerKeysError('KNOWLEDGE_SIGNER_KEYS has a key id that is not a short lower-case id.');
    let key: KeyObject;
    try {
      if (typeof pem !== 'string') throw new Error('not a string');
      key = createPublicKey(pem);
    } catch {
      // intentional: the parser's message can quote the key text
      throw new SignerKeysError(`KNOWLEDGE_SIGNER_KEYS: the key for "${keyId}" is not a PEM public key.`);
    }
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
      throw new SignerKeysError(`KNOWLEDGE_SIGNER_KEYS: the key for "${keyId}" is not a P-256 key.`);
    }
    // Two ids on one key would let one person pass as the two signers the rule asks for.
    const identity = keyIdentity(key);
    const holder = holders.get(identity);
    if (holder !== undefined) throw new SignerKeysError(`KNOWLEDGE_SIGNER_KEYS: "${holder}" and "${keyId}" hold the same key. Each signer needs a key of their own.`);
    holders.set(identity, keyId);
    keys.set(keyId, key);
  }
  return keys;
}

/**
 * What stops a reviewed real file from loading under the production rules, one line each, and the signers that did verify. `contentSha256` is the
 * hash the loader recomputed from the content, not the one the file states.
 */
export function checkSignatures(path: string, file: KnowledgeFile, contentSha256: string, keys: SignerKeys): { problems: string[]; signedBy: string[] } {
  if (file.review.status !== 'reviewed') return { problems: [], signedBy: [] };
  if (keys.size === 0) return { problems: [`${path}: no signer keys are configured (KNOWLEDGE_SIGNER_KEYS), so its signatures cannot be checked.`], signedBy: [] };
  const problems: string[] = [];
  const signedBy = new Set<string>();
  // Which signer each verified key belongs to. Checked here as well as in the parser: a caller can hand this function a trust list it built itself.
  const holders = new Map<string, string>();
  const message = signingMessage(file.id, contentSha256);
  for (const entry of file.review.signatures ?? []) {
    const key = keys.get(entry.keyId);
    if (key === undefined) {
      problems.push(`${path}: "${entry.keyId}" is not a configured signer.`);
      continue;
    }
    if (signedBy.has(entry.keyId)) {
      problems.push(`${path}: "${entry.keyId}" signed more than once.`);
      continue;
    }
    // The schema allows one algorithm only (ecdsa-p256-sha256), and the trust list holds P-256 keys only.
    if (!verify('sha256', message, { key, dsaEncoding: 'der' }, Buffer.from(entry.signature, 'base64'))) {
      problems.push(`${path}: the signature by "${entry.keyId}" does not match this file's content.`);
      continue;
    }
    const identity = keyIdentity(key);
    const holder = holders.get(identity);
    if (holder !== undefined) {
      problems.push(`${path}: "${holder}" and "${entry.keyId}" hold the same key, so they count as one signer.`);
      continue;
    }
    holders.set(identity, entry.keyId);
    signedBy.add(entry.keyId);
  }
  if (problems.length === 0 && signedBy.size < REQUIRED_SIGNERS) {
    problems.push(`${path}: needs valid signatures from ${REQUIRED_SIGNERS} distinct signers; has ${signedBy.size}.`);
  }
  return { problems, signedBy: problems.length === 0 ? [...signedBy].sort() : [] };
}
