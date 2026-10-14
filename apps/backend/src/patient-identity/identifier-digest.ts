import { createHmac, hkdfSync } from 'node:crypto';

/** The fixed key development and tests use. It is not secret: production refuses to start without its own (IDENTIFIER_DIGEST_KEY). */
export const DEVELOPMENT_IDENTIFIER_KEY = '0'.repeat(62) + '02';

/** Bumped only by the (not yet built) rotation procedure; stored with every digest so a later key can be told from this one. */
export const CURRENT_KEY_VERSION = 1;

const SALT = 'telesphoros/patient-identifier/v1';

/**
 * A clinic's identifier for a patient is never stored: only a keyed digest of it. The key for one organization is derived from one master secret
 * and the organization's id, so the same number in two organizations (or under two systems) produces two different stored values, and nothing in
 * the database can be matched across organizations. Matching is exact: the value is normalized for white space and letter case only, never for
 * punctuation, because a false match verifies a report against the wrong person.
 */
export class IdentifierDigest {
  private readonly master: Buffer;
  private readonly derived = new Map<string, Buffer>();

  constructor(masterHex: string = DEVELOPMENT_IDENTIFIER_KEY) {
    this.master = Buffer.from(masterHex, 'hex');
    if (this.master.length !== 32) throw new Error('The identifier digest key must be 32 bytes (64 hex characters).');
  }

  /** NFKC, trimmed, runs of white space collapsed to one space, upper case. */
  normalize(value: string): string {
    return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toUpperCase();
  }

  private keyFor(tenantId: string): Buffer {
    let key = this.derived.get(tenantId);
    if (!key) {
      key = Buffer.from(hkdfSync('sha256', this.master, SALT, `org:${tenantId}`, 32));
      this.derived.set(tenantId, key);
    }
    return key;
  }

  /** The 32-byte digest stored in `patient_identifiers.value_digest`. */
  digest(tenantId: string, system: string, value: string): Buffer {
    return createHmac('sha256', this.keyFor(tenantId)).update(system).update('\u0000').update(this.normalize(value)).digest();
  }
}
