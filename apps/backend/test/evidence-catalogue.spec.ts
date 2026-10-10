import { randomBytes } from 'node:crypto';
import { authenticateDocument, byteDigest, catalogueSchema, checkpointSchema, completionSchema, decryptDocument, digest, encryptDocument, EvidenceError, IncompleteEvidenceListingError, parse, signDocument, sourceIdentity, validateSources, type EvidenceCheckpoint, type EvidencePolicy, type ResolvedEvidence } from '../src/db/evidence-catalogue';
import { EvidenceBudget, listKeys, listVersions, type EvidenceStorage } from '../src/db/evidence-storage';

const key = randomBytes(32);
const policy: EvidencePolicy = { mode: 'COMPLIANCE', retainUntil: '2030-01-01T00:00:00Z', encryption: 'AES256', keyId: null };
function checkpoint(): EvidenceCheckpoint {
  const source: ResolvedEvidence = { reference: { tenantId: 'one', reportId: '00000000-0000-4000-8000-000000000001', captureId: null, kind: 'vcf', key: 'reports/one/file', dbVersion: null, sha256: byteDigest(Buffer.from('vcf')), sizeBytes: 3, contentType: 'text/plain', scalars: null, runner: null, popplerVersion: null }, observedVersion: 'v1', bytes: 3, sourceId: '0'.repeat(64) };
  source.sourceId = sourceIdentity('source', source);
  return { domain: 'telesphoros-evidence/checkpoint/1', generation: 'run-one', producedAt: '2026-10-10T01:00:00Z', binding: { manifestSha256: 'a'.repeat(64), archiveSha256: 'b'.repeat(64), plaintextSha256: 'c'.repeat(64), schemaSha256: 'd'.repeat(64), migrations: ['0001'], createdAt: '2026-10-10T00:00:00Z' }, policy, sourceBucket: 'source', destinationBucket: 'copy', destinationPrefix: 'evidence/', sources: [source], uncompletedRegistrations: 1, orphanTextObjects: 2 };
}

describe('authenticated evidence contract', () => {
  it('encrypts and authenticates the checkpoint; ciphertext exposes no raw inventory', async () => {
    const document = checkpoint(); const bytes = await encryptDocument(document, key);
    expect(bytes.includes(Buffer.from(document.sources[0].reference.key))).toBe(false);
    expect(await decryptDocument(bytes, key, checkpointSchema)).toEqual(document);
    await expect(decryptDocument(bytes, randomBytes(32), checkpointSchema)).rejects.toMatchObject({ code: 'authentication' });
    const tampered = Buffer.from(bytes); tampered[tampered.length - 1] ^= 1;
    await expect(decryptDocument(tampered, key, checkpointSchema)).rejects.toMatchObject({ code: 'authentication' });
  });
  it('refuses tampering, wrong message domains, unknown fields and malformed Unicode', () => {
    const bytes = signDocument(checkpoint(), key);
    expect(() => authenticateDocument(bytes, key, completionSchema)).toThrow(EvidenceError);
    const altered = JSON.parse(bytes.toString()); altered.payload.generation = 'other';
    expect(() => authenticateDocument(Buffer.from(JSON.stringify(altered)), key, checkpointSchema)).toThrow(EvidenceError);
    expect(() => parse(checkpointSchema, { ...checkpoint(), unknown: 'field' })).toThrow(EvidenceError);
    expect(() => authenticateDocument(Buffer.from([0xff]), key, checkpointSchema)).toThrow(EvidenceError);
  });
  it('refuses omitted, duplicate, foreign and null-version mappings', () => {
    const c = checkpoint(); const root = { ...c, domain: 'telesphoros-evidence/catalogue/1', mappings: [] };
    const valid = { sourceId: c.sources[0].sourceId, destinationVersion: 'destination-v1', mode: 'translated' };
    expect(parse(catalogueSchema, { ...root, mappings: [valid] }).mappings).toHaveLength(1);
    for (const mappings of [[], [valid, valid], [{ ...valid, sourceId: 'e'.repeat(64) }], [{ ...valid, destinationVersion: 'null' }]]) expect(() => parse(catalogueSchema, { ...root, mappings })).toThrow(EvidenceError);
  });
  it('does not accept counts or an object hash as membership proof', () => {
    const c = checkpoint(); validateSources(c.sources, c.sourceBucket);
    expect(() => validateSources([...c.sources, ...c.sources], c.sourceBucket)).toThrow(EvidenceError);
    expect(() => validateSources([{ ...c.sources[0], sourceId: digest('foreign') }], c.sourceBucket)).toThrow(EvidenceError);
    expect(() => validateSources([{ ...c.sources[0], bytes: 4 }], c.sourceBucket)).toThrow(EvidenceError);
  });
});

describe('bounded evidence discovery', () => {
  const store = (versions: jest.Mock, keys = jest.fn()): EvidenceStorage => ({ bucket: 'source', prefix: 'reports/', versions, keys, get: jest.fn(), put: jest.fn() });
  it('allows the terminal cap page and preserves a literal null version marker', async () => {
    const pages = jest.fn().mockResolvedValueOnce({ versions: [], truncated: true, keyMarker: 'reports/k', versionMarker: 'null' }).mockResolvedValueOnce({ versions: [{ key: 'reports/k', version: 'v1', deleted: false }], truncated: false });
    const result = await listVersions(store(pages), 'reports/k', new EvidenceBudget({ pages: 2 }));
    expect(result).toHaveLength(1); expect(pages.mock.calls[1][1]).toEqual({ keyMarker: 'reports/k', versionMarker: 'null' });
  });
  it.each([
    { versions: [], truncated: true },
    { versions: [], truncated: true, keyMarker: 'reports/k' },
    { versions: [], truncated: true, keyMarker: 'reports/k', versionMarker: '' },
  ])('refuses missing version cursors', async page => {
    await expect(listVersions(store(jest.fn().mockResolvedValue(page)), 'reports/k', new EvidenceBudget())).rejects.toBeInstanceOf(IncompleteEvidenceListingError);
  });
  it('refuses repeated cursors and a truncated cap, retaining no partial result', async () => {
    const page = { versions: [], truncated: true, keyMarker: 'reports/k', versionMarker: 'v1' };
    await expect(listVersions(store(jest.fn().mockResolvedValue(page)), 'reports/k', new EvidenceBudget())).rejects.toMatchObject({ reason: 'no-progress' });
    await expect(listVersions(store(jest.fn().mockResolvedValue(page)), 'reports/k', new EvidenceBudget({ pages: 1 }))).rejects.toMatchObject({ reason: 'page-limit' });
  });
  it('accepts terminal page 1000 and refuses truncated page 1000 without making request 1001', async () => {
    for (const lastTruncated of [false, true]) {
      let calls = 0;
      const pages = jest.fn(async () => {
        calls++;
        return { versions: [{ key: 'reports/k', version: 'v' + calls, deleted: false }], truncated: calls < 1000 || lastTruncated, keyMarker: 'reports/k', versionMarker: 'v' + calls };
      });
      const result = listVersions(store(pages), 'reports/k', new EvidenceBudget());
      if (lastTruncated) await expect(result).rejects.toMatchObject({ reason: 'page-limit' });
      else expect(await result).toHaveLength(1000);
      expect(calls).toBe(1000);
    }
  });
  it('refuses missing/repeated continuation tokens, aggregate byte/version exhaustion and deadlines', async () => {
    await expect(listKeys(store(jest.fn(), jest.fn().mockResolvedValue({ keys: [], truncated: true })), new EvidenceBudget())).rejects.toBeInstanceOf(IncompleteEvidenceListingError);
    await expect(listKeys(store(jest.fn(), jest.fn().mockResolvedValue({ keys: [], truncated: true, token: 'same' })), new EvidenceBudget())).rejects.toMatchObject({ reason: 'no-progress' });
    const budget = new EvidenceBudget({ bytes: 4, versions: 1 }); budget.read(2); budget.written(2);
    expect(() => budget.read(1)).toThrow(EvidenceError); budget.version(); expect(() => budget.version()).toThrow(EvidenceError);
    let now = 0; const timed = new EvidenceBudget({ deadlineMs: 1 }, () => now); now = 1; expect(() => timed.check()).toThrow(EvidenceError);
    now = 0; const fractional = new EvidenceBudget({ deadlineMs: 2 }, () => now); now = 0.1; expect(fractional.remainingMs()).toBe(1);
    now = 1.1; expect(() => fractional.remainingMs()).toThrow(EvidenceError);
    expect(() => new EvidenceBudget({ pages: 1001 })).toThrow(EvidenceError);
  });
});
