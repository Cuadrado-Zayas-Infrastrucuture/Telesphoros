import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { DecryptCommand, GenerateDataKeyCommand, KMSClient } from '@aws-sdk/client-kms';
import type { Env } from '../config/env';

/**
 * Where a patient's data key is wrapped (spec 025, D2/PD-3).
 *
 * Envelope encryption: each patient gets one random 256-bit data key; the identity fields are encrypted with it (identity-crypto.ts), and a PROVIDER wraps
 * the data key so only the wrapped copy is stored. The provider binds every wrap to an ENCRYPTION CONTEXT, {tenant, patient}: the wrapped key opens only
 * for that same pair. With AWS KMS the context is checked by KMS itself and appears in CloudTrail; the local provider checks it as authenticated data.
 */
export interface DataKeyContext {
  readonly tenant: string;
  readonly patient: string;
}

export interface GeneratedDataKey {
  /** The 32-byte data key. Held in memory only for the length of one request; never stored, logged or returned. */
  readonly plaintext: Buffer;
  /** The same key, wrapped by the provider. This is what `patient_field_keys.wrapped_key` stores. */
  readonly wrapped: Buffer;
}

export type FieldKeyProviderId = 'kms' | 'local';

export interface FieldKeyProvider {
  /** Stored beside the wrapped key, so a deployment that changes provider fails clearly instead of unwrapping with the wrong one. */
  readonly id: FieldKeyProviderId;
  generateDataKey(context: DataKeyContext): Promise<GeneratedDataKey>;
  /** Opens a wrapped key. Throws FieldKeyError when the context is not the one it was wrapped under, or the wrapped bytes were altered. */
  unwrap(wrapped: Buffer, context: DataKeyContext): Promise<Buffer>;
}

/** The injection token of the provider the application uses. */
export const FIELD_KEY_PROVIDER = Symbol('FIELD_KEY_PROVIDER');

/** A wrap or unwrap failed. The message is fixed text: it never carries a key, a context value or a provider's own message. */
export class FieldKeyError extends Error {
  constructor(
    readonly reason: 'unwrap-failed' | 'generate-failed' | 'malformed',
    /** The provider's error name (for example `InvalidCiphertextException`), for an operator. Never a message. */
    readonly providerCode?: string,
  ) {
    super(reason === 'generate-failed' ? 'A patient data key could not be created.' : 'A patient data key could not be opened.');
    this.name = 'FieldKeyError';
  }
}

const DATA_KEY_BYTES = 32;

/** The fixed key development and tests use. It is not secret: production refuses to start with a local provider at all (env.ts). */
export const DEVELOPMENT_FIELD_KEY = '0'.repeat(62) + '03';

const LOCAL_VERSION = 1;
const LOCAL_AAD_LABEL = Buffer.from('telesphoros/patient-field-key/local/v1', 'utf8');

/** Length-prefixed, so ('ab', 'c') and ('a', 'bc') can never produce the same bytes. */
function contextBytes(context: DataKeyContext): Buffer {
  const parts = [LOCAL_AAD_LABEL, Buffer.from(context.tenant, 'utf8'), Buffer.from(context.patient, 'utf8')];
  return Buffer.concat(parts.flatMap((part) => [uint32(part.length), part]));
}

function uint32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}

/**
 * Development and tests. Wraps the data key with AES-256-GCM under a key from the environment, with the encryption context as the associated data, so a
 * wrong context fails exactly where KMS would refuse it. Wrapped layout: version (1 byte) | nonce (12) | wrapped key (32) | tag (16).
 */
export class LocalFieldKeyProvider implements FieldKeyProvider {
  readonly id = 'local' as const;
  readonly #kek: Buffer;

  constructor(keyHex: string = DEVELOPMENT_FIELD_KEY) {
    this.#kek = Buffer.from(keyHex, 'hex');
    if (this.#kek.length !== 32) throw new Error('The local patient field key must be 32 bytes (64 hex characters).');
  }

  async generateDataKey(context: DataKeyContext): Promise<GeneratedDataKey> {
    const plaintext = randomBytes(DATA_KEY_BYTES);
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#kek, nonce);
    cipher.setAAD(contextBytes(context));
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return { plaintext, wrapped: Buffer.concat([Buffer.from([LOCAL_VERSION]), nonce, body, cipher.getAuthTag()]) };
  }

  async unwrap(wrapped: Buffer, context: DataKeyContext): Promise<Buffer> {
    if (wrapped.length !== 1 + 12 + DATA_KEY_BYTES + 16 || wrapped[0] !== LOCAL_VERSION) throw new FieldKeyError('malformed');
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.#kek, wrapped.subarray(1, 13));
      decipher.setAAD(contextBytes(context));
      decipher.setAuthTag(wrapped.subarray(1 + 12 + DATA_KEY_BYTES));
      return Buffer.concat([decipher.update(wrapped.subarray(13, 13 + DATA_KEY_BYTES)), decipher.final()]);
    } catch {
      throw new FieldKeyError('unwrap-failed');
    }
  }
}

/**
 * AWS KMS. `GenerateDataKey` returns a random 256-bit key and its wrapped copy under the configured KMS key; `Decrypt` opens it. Both name the encryption
 * context {tenant, patient}: KMS refuses a Decrypt whose context differs from the one the key was generated under, and IAM can require the context
 * (slice PD-b). Decrypt also names the key id, so a blob made under another KMS key is refused here instead of being accepted from whatever key made it.
 */
export class KmsFieldKeyProvider implements FieldKeyProvider {
  readonly id = 'kms' as const;

  constructor(
    private readonly client: Pick<KMSClient, 'send'>,
    private readonly keyId: string,
  ) {}

  async generateDataKey(context: DataKeyContext): Promise<GeneratedDataKey> {
    try {
      const out = await this.client.send(new GenerateDataKeyCommand({ KeyId: this.keyId, KeySpec: 'AES_256', EncryptionContext: this.encryptionContext(context) }));
      if (!out.Plaintext || !out.CiphertextBlob || out.Plaintext.length !== DATA_KEY_BYTES) throw new FieldKeyError('generate-failed');
      return { plaintext: Buffer.from(out.Plaintext), wrapped: Buffer.from(out.CiphertextBlob) };
    } catch (error) {
      throw error instanceof FieldKeyError ? error : new FieldKeyError('generate-failed', errorName(error));
    }
  }

  async unwrap(wrapped: Buffer, context: DataKeyContext): Promise<Buffer> {
    try {
      const out = await this.client.send(new DecryptCommand({ CiphertextBlob: wrapped, KeyId: this.keyId, EncryptionContext: this.encryptionContext(context) }));
      if (!out.Plaintext || out.Plaintext.length !== DATA_KEY_BYTES) throw new FieldKeyError('unwrap-failed');
      return Buffer.from(out.Plaintext);
    } catch (error) {
      throw error instanceof FieldKeyError ? error : new FieldKeyError('unwrap-failed', errorName(error));
    }
  }

  /** The two values KMS records in CloudTrail and IAM can require. They are identifiers, never names or dates. */
  private encryptionContext(context: DataKeyContext): Record<string, string> {
    return { tenant: context.tenant, patient: context.patient };
  }
}

const errorName = (error: unknown): string | undefined => (error instanceof Error ? error.name : undefined);

/**
 * The provider the environment selects. Production has the KMS key id (env.ts refuses anything else); development and tests have the local key, or the
 * fixed non-secret one. Credentials for KMS come from the default provider chain (an IAM role in AWS), never from our configuration.
 */
export function createFieldKeyProvider(env: Pick<Env, 'NODE_ENV' | 'PATIENT_FIELD_KMS_KEY_ID' | 'PATIENT_FIELD_LOCAL_KEY' | 'AWS_REGION' | 'KMS_ENDPOINT'>): FieldKeyProvider {
  if (env.PATIENT_FIELD_KMS_KEY_ID) {
    return new KmsFieldKeyProvider(new KMSClient({ region: env.AWS_REGION, ...(env.KMS_ENDPOINT ? { endpoint: env.KMS_ENDPOINT } : {}) }), env.PATIENT_FIELD_KMS_KEY_ID);
  }
  // env.ts already refuses this; the second check is here because this is the line that would otherwise start a local provider in a deployed build.
  if (env.NODE_ENV === 'production') throw new Error('The local patient field key provider is refused in production: PATIENT_FIELD_KMS_KEY_ID is required.');
  return new LocalFieldKeyProvider(env.PATIENT_FIELD_LOCAL_KEY);
}
