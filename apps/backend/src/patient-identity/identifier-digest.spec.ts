import { DEVELOPMENT_IDENTIFIER_KEY, IdentifierDigest } from './identifier-digest';

/**
 * The expected values below were computed by an independent implementation (HKDF-SHA-256 and HMAC-SHA-256 written out from their definitions in
 * Python), not by this code: they are the oracle for the key derivation, the separator and the normalization.
 */
const hex = (digest: Buffer) => digest.toString('hex');
const subject = new IdentifierDigest(DEVELOPMENT_IDENTIFIER_KEY);

describe('the identifier digest', () => {
  it('matches the independently computed known answer', () => {
    expect(hex(subject.digest('tenant-a', 'hospital-a-mrn', 'mrn-0001'))).toBe('92d2da490ece0b24972c8fac3f81555a9cf88b59b180e37f1bac6561d1b6a075');
  });

  it('is 32 bytes, and different for another organization, another system or another key (the same number never matches across them)', () => {
    const base = subject.digest('tenant-a', 'hospital-a-mrn', 'mrn-0001');
    expect(base).toHaveLength(32);
    expect(hex(subject.digest('tenant-b', 'hospital-a-mrn', 'mrn-0001'))).toBe('aeead09444afaba57981e923da89f117d47efc2f341dd525d3028dee33e50543');
    expect(hex(subject.digest('tenant-a', 'hospital-b-mrn', 'mrn-0001'))).toBe('6eab31a80b0606eb492ad2067c798559e26565cfcb75bbc5c864ffed9b37ddae');
    expect(hex(new IdentifierDigest('ab'.repeat(32)).digest('tenant-a', 'hospital-a-mrn', 'mrn-0001'))).toBe('f8b9ff957b56eda985e657aa97e9ca3a2b0e1769de2a235860ce3b9b182c6cb8');
    for (const other of [subject.digest('tenant-b', 'hospital-a-mrn', 'mrn-0001'), subject.digest('tenant-a', 'hospital-b-mrn', 'mrn-0001')])
      expect(other.equals(base)).toBe(false);
  });

  it('ignores white space and letter case, and nothing else (matching is exact: a false match verifies a report against the wrong person)', () => {
    const base = hex(subject.digest('tenant-a', 'hospital-a-mrn', 'mrn-0001'));
    expect(hex(subject.digest('tenant-a', 'hospital-a-mrn', '  Mrn-0001 '))).toBe(base);
    expect(hex(subject.digest('tenant-a', 'hospital-a-mrn', 'mrn -0001'))).not.toBe(base); // a stray space inside is a different number, not a typo to forgive
    expect(hex(subject.digest('tenant-a', 'hospital-a-mrn', 'MRN0001'))).toBe('4ac18c8f7c1463d1371b7669628f4052899eb257c68f4f8afe67ae97a8f5b8ab'); // punctuation is kept
    expect(hex(subject.digest('tenant-a', 'hospital-a-mrn', 'MRN0001'))).not.toBe(base);
    // Full-width forms fold to the same characters (NFKC), so a pasted full-width number matches.
    expect(hex(subject.digest('tenant-a', 'hospital-a-mrn', 'ＭＲＮ-０００１'))).toBe(base);
  });

  it('keeps the system and the value apart (a value cannot borrow the end of the system)', () => {
    expect(hex(subject.digest('t', 'ab', 'c'))).not.toBe(hex(subject.digest('t', 'a', 'bc')));
  });

  it('refuses a key that is not 32 bytes', () => {
    expect(() => new IdentifierDigest('abcd')).toThrow(/32 bytes/);
  });
});
