import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { tenantIdSchema } from '@telesphoros/shared-types';
import { z } from 'zod';
import { SessionCustodyError } from '../storage/browser-session.repository';

const keyId = /^[A-Za-z0-9_-]{1,32}$/;
const encoded = /^[A-Za-z0-9_-]+$/;
const locatorSchema = z.strictObject({
  tenantId: tenantIdSchema,
  handle: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  expiresAt: z.number().int().positive().max(8_640_000_000_000_000),
});
export type SessionLocator = z.infer<typeof locatorSchema>;
export const MAX_ACCESS_TOKEN_BYTES = 8192;

/** Independent session-purpose keys; never reuse the backup or patient-identifier master. */
export class SessionCrypto {
  readonly #keys = new Map<string, Buffer>();

  constructor(private readonly activeKeyId: string, keys: ReadonlyMap<string, Buffer>) {
    if (!keyId.test(activeKeyId) || keys.size < 1 || keys.size > 8 || !keys.has(activeKeyId)) throw new SessionCustodyError('invalid');
    for (const [id, key] of keys) {
      if (!keyId.test(id) || !Buffer.isBuffer(key) || key.length !== 32) throw new SessionCustodyError('invalid');
      this.#keys.set(id, Buffer.from(key));
    }
  }

  newHandle(): string { return randomBytes(32).toString('base64url'); }

  hashHandle(handle: string): string {
    this.decode(handle, 32);
    return createHash('sha256').update(handle, 'ascii').digest('hex');
  }

  sealLocator(locator: SessionLocator): string {
    const checked = locatorSchema.safeParse(locator);
    if (!checked.success) throw new SessionCustodyError('invalid');
    this.decode(checked.data.handle, 32);
    return this.seal('locator', '', JSON.stringify(checked.data));
  }

  /** Invalid browser input is a missing session, never a tenant locator trusted before authentication. */
  openLocator(value: string): SessionLocator | undefined {
    try {
      const locator = locatorSchema.parse(JSON.parse(this.open('locator', '', value, 1024)));
      this.decode(locator.handle, 32);
      return locator;
    } catch { return undefined; }
  }

  sealCredential(token: string, context: string): string {
    this.checkToken(token);
    return this.seal('credential', context, token);
  }

  openCredential(value: string, context: string): string {
    const token = this.open('credential', context, value, 16_384);
    this.checkToken(token);
    return token;
  }

  private checkToken(token: string): void {
    if (typeof token !== 'string' || !token || Buffer.byteLength(token, 'utf8') > MAX_ACCESS_TOKEN_BYTES || /\s/.test(token)) throw new SessionCustodyError('invalid');
  }

  private derive(id: string, purpose: string): Buffer {
    const master = this.#keys.get(id);
    if (!master) throw new SessionCustodyError('invalid');
    return Buffer.from(hkdfSync('sha256', master, 'telesphoros-browser-session-v1', `${purpose}:${id}`, 32));
  }

  private seal(purpose: string, context: string, plaintext: string): string {
    if (typeof context !== 'string' || Buffer.byteLength(context) > 4096) throw new SessionCustodyError('invalid');
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.derive(this.activeKeyId, purpose), nonce);
    cipher.setAAD(Buffer.from(JSON.stringify(['m51a', purpose, this.activeKeyId, context])));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return ['v1', this.activeKeyId, nonce.toString('base64url'), ciphertext.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
  }

  private open(purpose: string, context: string, value: string, maximum: number): string {
    try {
      if (typeof value !== 'string' || value.length > maximum || typeof context !== 'string' || Buffer.byteLength(context) > 4096) throw new SessionCustodyError('invalid');
      const parts = value.split('.');
      if (parts.length !== 5 || parts[0] !== 'v1' || !keyId.test(parts[1]!)) throw new SessionCustodyError('invalid');
      const [, id, iv, body, tag] = parts as [string, string, string, string, string];
      const decipher = createDecipheriv('aes-256-gcm', this.derive(id, purpose), this.decode(iv, 12));
      decipher.setAAD(Buffer.from(JSON.stringify(['m51a', purpose, id, context])));
      decipher.setAuthTag(this.decode(tag, 16));
      return Buffer.concat([decipher.update(this.decode(body)), decipher.final()]).toString('utf8');
    } catch { throw new SessionCustodyError('invalid'); }
  }

  private decode(value: string, length?: number): Buffer {
    if (!encoded.test(value)) throw new SessionCustodyError('invalid');
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value || (length !== undefined && bytes.length !== length)) throw new SessionCustodyError('invalid');
    return bytes;
  }
}
