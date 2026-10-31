import { randomBytes } from 'node:crypto';
import { associatedData, IDENTITY_FIELDS, IdentityCryptoError, NAME_PADDED_BYTES, openField, requestFingerprint, sealField } from './identity-crypto';

const key = randomBytes(32);
const binding = { tenant: 'syn-tenant-1', patient: '11111111-1111-4111-8111-111111111111', keyVersion: 1 };
const VALUE = 'Synthetic-Zzyzx-Given';

describe('sealField / openField', () => {
  it('round-trips every field, with a 12-byte nonce; names are padded to one size, the date of birth is the plaintext plus a 16-byte tag', () => {
    for (const field of IDENTITY_FIELDS) {
      const value = field === 'date_of_birth' ? '1980-02-29' : VALUE;
      const sealed = sealField(key, binding, field, value);
      expect(sealed.nonce).toHaveLength(12);
      expect(sealed.ciphertext).toHaveLength(field === 'date_of_birth' ? 10 + 16 : NAME_PADDED_BYTES + 16);
      expect(openField(key, binding, field, sealed)).toBe(value);
    }
  });

  it('hides how long a name is: a one-letter name and the longest accepted name give ciphertexts of the same length', () => {
    const lengths = ['A', VALUE, 'Ñ'.repeat(100), '𝒜'.repeat(100)].map((name) => sealField(key, binding, 'given_name', name).ciphertext.length);
    expect(new Set(lengths)).toEqual(new Set([NAME_PADDED_BYTES + 16]));
    for (const name of ['A', 'Ñ'.repeat(100), '𝒜'.repeat(100)]) expect(openField(key, binding, 'family_name', sealField(key, binding, 'family_name', name))).toBe(name);
  });

  it('refuses a name too long to pad, rather than storing a longer ciphertext', () => {
    expect(() => sealField(key, binding, 'given_name', 'x'.repeat(401))).toThrow(IdentityCryptoError);
  });

  it('does not contain the plaintext in the ciphertext or the nonce', () => {
    const sealed = sealField(key, binding, 'given_name', VALUE);
    expect(Buffer.concat([sealed.nonce, sealed.ciphertext]).includes(Buffer.from(VALUE))).toBe(false);
  });

  it('uses a fresh nonce for every field and every call (the same value never gives the same ciphertext)', () => {
    const nonces = new Set<string>();
    const ciphertexts = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const sealed = sealField(key, binding, 'given_name', VALUE);
      nonces.add(sealed.nonce.toString('hex'));
      ciphertexts.add(sealed.ciphertext.toString('hex'));
    }
    expect(nonces.size).toBe(200);
    expect(ciphertexts.size).toBe(200);
  });

  // PD-2: tenant, patient, field name and key version are all bound. Each case moves exactly ONE of them, so a missing term in the associated data is caught.
  it.each([
    ['another tenant', { ...binding, tenant: 'syn-tenant-2' }, 'given_name'],
    ['another patient', { ...binding, patient: '22222222-2222-4222-8222-222222222222' }, 'given_name'],
    ['another key version', { ...binding, keyVersion: 2 }, 'given_name'],
    ['another field', binding, 'family_name'],
  ] as const)('does not decrypt a ciphertext moved to %s', (_label, wrong, field) => {
    const sealed = sealField(key, binding, 'given_name', VALUE);
    expect(() => openField(key, wrong, field, sealed)).toThrow(IdentityCryptoError);
    expect(openField(key, binding, 'given_name', sealed)).toBe(VALUE); // positive control: the same bytes open where they belong
  });

  it('does not decrypt under another key, with another nonce, or after any byte changes', () => {
    const sealed = sealField(key, binding, 'date_of_birth', '1990-01-31');
    expect(() => openField(randomBytes(32), binding, 'date_of_birth', sealed)).toThrow(IdentityCryptoError);
    expect(() => openField(key, binding, 'date_of_birth', { ...sealed, nonce: randomBytes(12) })).toThrow(IdentityCryptoError);
    for (let i = 0; i < sealed.ciphertext.length; i++) {
      const altered = Buffer.from(sealed.ciphertext);
      altered[i] = altered[i]! ^ 0x80;
      expect(() => openField(key, binding, 'date_of_birth', { ...sealed, ciphertext: altered })).toThrow(IdentityCryptoError);
    }
  });

  it('refuses a short nonce or a ciphertext with no body, with fixed text', () => {
    const sealed = sealField(key, binding, 'given_name', VALUE);
    expect(() => openField(key, binding, 'given_name', { ...sealed, nonce: sealed.nonce.subarray(1) })).toThrow('A patient identity field could not be decrypted.');
    expect(() => openField(key, binding, 'given_name', { ...sealed, ciphertext: sealed.ciphertext.subarray(0, 16) })).toThrow(IdentityCryptoError);
  });

  it('handles non-ASCII names', () => {
    const sealed = sealField(key, binding, 'family_name', 'Núñez-Ibáñez');
    expect(openField(key, binding, 'family_name', sealed)).toBe('Núñez-Ibáñez');
  });
});

describe('associatedData', () => {
  it('differs for every single component, and a character moved between two components changes it', () => {
    const base = associatedData(binding, 'given_name');
    const variants = [
      associatedData({ ...binding, tenant: 'syn-tenant-1x' }, 'given_name'),
      associatedData({ ...binding, patient: binding.patient.replace('1', '3') }, 'given_name'),
      associatedData({ ...binding, keyVersion: 2 }, 'given_name'),
      associatedData(binding, 'family_name'),
      associatedData({ tenant: 'syn-tenant-', patient: `1${binding.patient}`, keyVersion: 1 }, 'given_name'),
    ];
    for (const variant of variants) expect(variant.equals(base)).toBe(false);
    expect(new Set([base, ...variants].map((b) => b.toString('hex'))).size).toBe(6);
  });
});

describe('requestFingerprint', () => {
  it('is keyed: the same request under another data key gives another value, and it is not a plain hash of the request', () => {
    const parts = ['p', 'Synthetic', 'Person', '1990-01-31', 'female', null] as const;
    const a = requestFingerprint(key, parts);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(requestFingerprint(key, parts)).toBe(a);
    expect(requestFingerprint(randomBytes(32), parts)).not.toBe(a);
    expect(requestFingerprint(key, [...parts.slice(0, 5), ['white']])).not.toBe(a);
  });
});
