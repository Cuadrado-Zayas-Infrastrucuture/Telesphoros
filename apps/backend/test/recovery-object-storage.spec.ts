import { randomBytes } from 'node:crypto';
import { byteDigest, encryptDocument, sourceIdentity, type EvidenceCatalogue, type ResolvedEvidence } from '../src/db/evidence-catalogue';
import { InMemoryObjectStorage } from '../src/object-storage/in-memory-object-storage';
import { RecoveryObjectStorage } from '../src/object-storage/recovery-object-storage';

async function fixture(kind: 'lab-pdf' | 'structured' = 'lab-pdf', mode: 'translated' | 'native' = 'translated') {
  class ApplicationBucket extends InMemoryObjectStorage {
    readonly bucket = 'synthetic-app';
  }
  const target = new ApplicationBucket();
  const bytes = Buffer.from('synthetic file');
  const key = randomBytes(32);
  const item: ResolvedEvidence = {
    reference: {
      tenantId: 'synthetic-one',
      reportId: '00000000-0000-4000-8000-000000000001',
      captureId: null,
      kind,
      key: 'reports/original',
      dbVersion: kind === 'lab-pdf' ? 'mem-v1' : null,
      sha256: byteDigest(bytes),
      sizeBytes: bytes.length,
      contentType: 'application/pdf',
      scalars: null,
      runner: null,
      popplerVersion: null,
    },
    observedVersion: 'mem-v1',
    bytes: bytes.length,
    sourceId: '',
  };
  item.sourceId = sourceIdentity('synthetic-primary', item);
  const destinationKey = mode === 'native' ? item.reference.key : 'installed/synthetic/objects/' + item.sourceId;
  if (mode === 'translated') target.put('unrelated', Buffer.from('other'), 'application/octet-stream');
  const version = target.put(destinationKey, bytes, item.reference.contentType)!;
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
    sourceBucket: 'synthetic-primary',
    destinationBucket: 'synthetic-app',
    destinationPrefix: 'installed/',
    sources: [item],
    mappings: [{ sourceId: item.sourceId, destinationVersion: version, mode }],
    uncompletedRegistrations: 0,
    orphanTextObjects: 0,
  };
  const options = {
    target,
    encryptedCatalogue: await encryptDocument(catalogue, key),
    catalogueKey: key,
    expected: {
      binding: catalogue.binding,
      references: [item.reference],
      uncompletedRegistrations: 0,
      sourceBucket: catalogue.sourceBucket,
      destinationBucket: catalogue.destinationBucket,
      destinationPrefix: catalogue.destinationPrefix,
    },
  };
  return { options, catalogue, destinationKey, version, target, item, bytes };
}
describe('authenticated recovery storage, explicit activation only', () => {
  it('keeps the logical PDF pin while signed links name the verified translated destination', async () => {
    const f = await fixture();
    const storage = await RecoveryObjectStorage.open(f.options);
    f.target.put(f.destinationKey, Buffer.from('newer substitute'), 'application/pdf');
    const object = await storage.getObject(f.item.reference.key, { version: 'mem-v1', maxBytes: 100 });
    expect(object!.bytes).toEqual(f.bytes);
    expect(object!.version).toBe('mem-v1');
    expect(await storage.createDownloadUrl(f.item.reference.key, 'mem-v1', 60)).toContain('versionId=' + f.version);
    // The installed version id is not a logical pin: like any store, a version that does not exist is not found.
    expect(await storage.getObject(f.item.reference.key, { version: f.version, maxBytes: 100 })).toBeUndefined();
    await expect(storage.getObject(f.item.reference.key, { maxBytes: 1 })).rejects.toMatchObject({ name: 'ObjectTooLargeError' });
  });
  it('resolves a completed standard report without a DB pin to its verified observed identity', async () => {
    const f = await fixture('structured');
    const storage = await RecoveryObjectStorage.open(f.options);
    expect((await storage.inspect(f.item.reference.key))!.version).toBe(f.item.observedVersion);
  });
  it('honors the native original-key/version contract without claiming provider replication', async () => {
    const f = await fixture('lab-pdf', 'native');
    const storage = await RecoveryObjectStorage.open(f.options);
    expect(await storage.createDownloadUrl(f.item.reference.key, f.item.observedVersion, 60)).toContain('download/reports/original?versionId=mem-v1');
  });
  it('refuses omitted membership, changed DB binding, wrong key and foreign destination before exposure', async () => {
    const f = await fixture();
    for (const expected of [
      { ...f.options.expected, references: [] },
      { ...f.options.expected, destinationBucket: 'foreign' },
      { ...f.options.expected, binding: { ...f.catalogue.binding, manifestSha256: 'e'.repeat(64) } },
    ]) {
      await expect(RecoveryObjectStorage.open({ ...f.options, expected })).rejects.toMatchObject({ code: 'binding' });
    }
    await expect(RecoveryObjectStorage.open({ ...f.options, catalogueKey: randomBytes(32) })).rejects.toMatchObject({ code: 'authentication' });
  });
  it('refuses a missing installed pin both at startup and later before signing even with a latest substitute', async () => {
    const f = await fixture();
    const storage = await RecoveryObjectStorage.open(f.options);
    f.target.put(f.destinationKey, f.bytes, 'application/pdf');
    f.target.deleteVersion(f.destinationKey, f.version);
    await expect(RecoveryObjectStorage.open(f.options)).rejects.toMatchObject({ code: 'missing' });
    await expect(storage.createDownloadUrl(f.item.reference.key, 'mem-v1', 60)).rejects.toMatchObject({ code: 'missing' });
    // A catalogued copy that vanished after startup verified it is a broken restore, not an ordinary missing file: it stays an error.
    await expect(storage.getObject(f.item.reference.key, { version: 'mem-v1', maxBytes: 100 })).rejects.toMatchObject({ code: 'missing' });
    await expect(storage.inspect(f.item.reference.key, { version: 'mem-v1' })).rejects.toMatchObject({ code: 'missing' });
  });
  it('answers "not found" for an object the restore does not contain, as every store does (audit O1), and still never signs one', async () => {
    const f = await fixture();
    const storage = await RecoveryObjectStorage.open(f.options);
    expect(await storage.getObject('reports/absent', { maxBytes: 100 })).toBeUndefined();
    expect(await storage.inspect('reports/absent')).toBeUndefined();
    expect(await storage.inspect(f.item.reference.key, { version: 'absent-pin' })).toBeUndefined();
    await expect(storage.createDownloadUrl('reports/absent', 'mem-v1', 60)).rejects.toMatchObject({ code: 'missing' });
  });
  it('checks actual bytes even if a storage port lies about the hash; refuses writes and excessive link lifetime', async () => {
    const f = await fixture();
    const storage = await RecoveryObjectStorage.open(f.options);
    const get = f.target.getObject.bind(f.target);
    f.target.getObject = async (...args) => {
      const object = await get(...args);
      return object ? { ...object, bytes: Buffer.alloc(object.bytes.length) } : object;
    };
    await expect(storage.inspect(f.item.reference.key)).rejects.toMatchObject({ code: 'integrity' });
    await expect(storage.createDownloadUrl(f.item.reference.key, 'mem-v1', 901)).rejects.toMatchObject({ code: 'policy' });
    await expect(storage.putObject()).rejects.toMatchObject({ status: 503 });
  });
});
