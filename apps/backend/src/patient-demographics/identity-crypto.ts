import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';

/**
 * The encryption of a patient's identity fields (spec 025, D2/PD-2), AES-256-GCM under the patient's data key.
 *
 * Each field gets a FRESH 96-bit random nonce, and its associated data binds the ciphertext to its tenant, patient, field name and key version. A ciphertext
 * moved to another patient, another tenant, another field or another key version fails the authentication tag and decrypts to nothing. The associated data is
 * length-prefixed, so no two different bindings produce the same bytes.
 *
 * A stored field is `ciphertext || 16-byte tag` in one column and its nonce in another (the table's CHECKs pin both lengths).
 */
export const IDENTITY_FIELDS = ['given_name', 'family_name', 'date_of_birth'] as const;
export type IdentityField = (typeof IDENTITY_FIELDS)[number];

export interface IdentityBinding {
  readonly tenant: string;
  readonly patient: string;
  readonly keyVersion: number;
}

export interface SealedField {
  /** 12 bytes, random, never reused with the same key. */
  readonly nonce: Buffer;
  /** The ciphertext followed by its 16-byte authentication tag. */
  readonly ciphertext: Buffer;
}

export class IdentityCryptoError extends Error {
  constructor() {
    super('A patient identity field could not be decrypted.'); // fixed text: never the field name, the binding or any value
    this.name = 'IdentityCryptoError';
  }
}

const LABEL = Buffer.from('telesphoros/patient-identity/v1', 'utf8');
const TAG_BYTES = 16;
const NONCE_BYTES = 12;

function uint32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}

/** The associated data of one field: label, tenant, patient, field name and key version, each length-prefixed. */
export function associatedData(binding: IdentityBinding, field: IdentityField): Buffer {
  const parts = [LABEL, Buffer.from(binding.tenant, 'utf8'), Buffer.from(binding.patient, 'utf8'), Buffer.from(field, 'utf8'), uint32(binding.keyVersion)];
  return Buffer.concat(parts.flatMap((part) => [uint32(part.length), part]));
}

/**
 * Names are padded to one fixed size before encryption, so a stored ciphertext does not reveal how long the name is: a 2-byte length, the UTF-8 bytes,
 * zeros to NAME_PADDED_BYTES. 400 bytes hold the longest name the API accepts (100 characters of at most 4 bytes each). The date of birth is always
 * 10 characters (YYYY-MM-DD), so it needs none. The table's CHECK pins both lengths.
 */
export const NAME_PADDED_BYTES = 2 + 400;
const isName = (field: IdentityField) => field !== 'date_of_birth';

function pad(text: string): Buffer {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length > NAME_PADDED_BYTES - 2) throw new IdentityCryptoError();
  const out = Buffer.alloc(NAME_PADDED_BYTES);
  out.writeUInt16BE(bytes.length);
  bytes.copy(out, 2);
  return out;
}

function unpad(padded: Buffer): string {
  if (padded.length !== NAME_PADDED_BYTES) throw new IdentityCryptoError();
  const length = padded.readUInt16BE(0);
  if (length > NAME_PADDED_BYTES - 2 || padded.subarray(2 + length).some((b) => b !== 0)) throw new IdentityCryptoError();
  return padded.subarray(2, 2 + length).toString('utf8');
}

export function sealField(dataKey: Buffer, binding: IdentityBinding, field: IdentityField, plaintext: string): SealedField {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', dataKey, nonce);
  cipher.setAAD(associatedData(binding, field));
  const payload = isName(field) ? pad(plaintext) : Buffer.from(plaintext, 'utf8');
  const body = Buffer.concat([cipher.update(payload), cipher.final()]);
  return { nonce, ciphertext: Buffer.concat([body, cipher.getAuthTag()]) };
}

export function openField(dataKey: Buffer, binding: IdentityBinding, field: IdentityField, sealed: SealedField): string {
  if (sealed.nonce.length !== NONCE_BYTES || sealed.ciphertext.length <= TAG_BYTES) throw new IdentityCryptoError();
  try {
    const decipher = createDecipheriv('aes-256-gcm', dataKey, sealed.nonce);
    decipher.setAAD(associatedData(binding, field));
    decipher.setAuthTag(sealed.ciphertext.subarray(sealed.ciphertext.length - TAG_BYTES));
    const payload = Buffer.concat([decipher.update(sealed.ciphertext.subarray(0, sealed.ciphertext.length - TAG_BYTES)), decipher.final()]);
    return isName(field) ? unpad(payload) : payload.toString('utf8');
  } catch {
    throw new IdentityCryptoError();
  }
}

/**
 * The retry fingerprint of a request, stored with the version it created. It is a KEYED hash under a key derived from the patient's data key, never a plain
 * hash: a name and a date of birth have so little entropy that a plain sha-256 of them could be guessed from the database. Destroying the data key (D8)
 * leaves a value nobody can test a guess against.
 */
export function requestFingerprint(dataKey: Buffer, parts: readonly unknown[]): string {
  const key = Buffer.from(hkdfSync('sha256', dataKey, 'telesphoros/patient-demographics/request', 'request-fingerprint', 32));
  return createHmac('sha256', key).update(JSON.stringify(parts)).digest('hex');
}
