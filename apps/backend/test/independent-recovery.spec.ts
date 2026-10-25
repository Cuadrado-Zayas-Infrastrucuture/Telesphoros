import { byteDigest, catalogueSchema, EvidenceError, parse, sourceIdentity, type EvidenceCatalogue, type ResolvedEvidence } from '../src/db/evidence-catalogue';
import { mappingLocation } from './helpers/independent-recovery';

const item: ResolvedEvidence = {
  reference: {
    tenantId: 'syn-native',
    reportId: '00000000-0000-4000-8000-000000000001',
    captureId: null,
    kind: 'lab-pdf',
    key: 'reports/original.pdf',
    dbVersion: 'source-version',
    sha256: byteDigest(Buffer.from('pdf')),
    sizeBytes: 3,
    contentType: 'application/pdf',
    scalars: null,
    runner: null,
    popplerVersion: null,
  },
  observedVersion: 'source-version',
  bytes: 3,
  sourceId: '',
};
item.sourceId = sourceIdentity('primary', item);
const catalogue: EvidenceCatalogue = {
  domain: 'telesphoros-evidence/catalogue/1',
  generation: 'synthetic',
  producedAt: '2026-10-10T00:00:00Z',
  binding: {
    manifestSha256: 'a'.repeat(64),
    archiveSha256: 'b'.repeat(64),
    plaintextSha256: 'c'.repeat(64),
    schemaSha256: 'd'.repeat(64),
    migrations: [],
    createdAt: '2026-10-10T00:00:00Z',
  },
  policy: { mode: 'COMPLIANCE', retainUntil: '2030-01-01T00:00:00Z', encryption: 'AES256', keyId: null },
  sourceBucket: 'primary',
  destinationBucket: 'copy',
  destinationPrefix: 'catalogues/',
  sources: [item],
  mappings: [{ sourceId: item.sourceId, destinationVersion: 'copy-version', mode: 'translated' }],
  uncompletedRegistrations: 0,
  orphanTextObjects: 0,
};

describe('F2 identity contracts, not native replication proof', () => {
  it('translated copies use the signed generation mapping and destination VersionId', () => {
    expect(mappingLocation(parse(catalogueSchema, catalogue), item)).toEqual({ key: 'catalogues/synthetic/objects/' + item.sourceId, version: 'copy-version', mode: 'translated' });
  });
  it('native identity keeps the original key and VersionId, not a translated key', () => {
    const native = parse(catalogueSchema, { ...catalogue, mappings: [{ sourceId: item.sourceId, destinationVersion: item.observedVersion, mode: 'native' }] });
    expect(mappingLocation(native, item)).toEqual({ key: item.reference.key, version: item.observedVersion, mode: 'native' });
  });
  it('refuses changed native identity and missing mappings', () => {
    expect(() => parse(catalogueSchema, { ...catalogue, mappings: [{ ...catalogue.mappings[0], mode: 'native' }] })).toThrow(EvidenceError);
    expect(() => mappingLocation({ ...catalogue, mappings: [] }, item)).toThrow(EvidenceError);
  });
});
