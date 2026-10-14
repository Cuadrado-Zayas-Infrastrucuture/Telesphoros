import { createHmac } from 'node:crypto';

/** The fixed key development and tests use. It is not secret: production refuses to start without its own (INVITATION_DIGEST_KEY). */
export const DEVELOPMENT_DIGEST_KEY = '0'.repeat(63) + '1';

const MAX_DOMAIN_IN_HINT = 60;

/**
 * An invited person's address is never stored: only a keyed digest (to recognize the same address again and let the operator confirm it) and a
 * masked hint (to tell invitations apart on screen). The address is normalized first (trimmed, lower case), so the same person always
 * produces the same digest.
 */
export class InvitationDigest {
  private readonly key: Buffer;

  constructor(keyHex: string = DEVELOPMENT_DIGEST_KEY) {
    this.key = Buffer.from(keyHex, 'hex');
    if (this.key.length !== 32) throw new Error('The invitation digest key must be 32 bytes (64 hex characters).');
  }

  normalize(email: string): string {
    return email.trim().toLowerCase();
  }

  digest(email: string): Buffer {
    return createHmac('sha256', this.key).update(this.normalize(email)).digest();
  }

  /** `j***@example.org`: the first character of the local part and the domain. Never enough to reconstruct the address. */
  hint(email: string): string {
    const [local = '', domain = ''] = this.normalize(email).split('@');
    const shown = domain.length > MAX_DOMAIN_IN_HINT ? `${domain.slice(0, MAX_DOMAIN_IN_HINT)}...` : domain;
    return `${local.slice(0, 1)}***@${shown}`;
  }
}
