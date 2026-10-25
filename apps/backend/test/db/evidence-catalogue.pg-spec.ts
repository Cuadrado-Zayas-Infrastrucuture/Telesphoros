import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { CreateBucketCommand, DeleteObjectCommand, PutBucketVersioningCommand } from '@aws-sdk/client-s3';
import { createBackup } from '../../src/db/backup';
import { generateKeyFile } from '../../src/db/backup-crypto';
import { readEvidenceInventory, type EvidenceInventory } from '../../src/db/evidence-inventory';
import { EvidenceBudget } from '../../src/db/evidence-storage';
import type { EvidenceStorage } from '../../src/db/evidence-storage';
import { byteDigest, checkpointSchema, decryptDocument, encryptDocument, EvidenceError, type EvidencePolicy } from '../../src/db/evidence-catalogue';
import { produceEvidenceCatalogue, type CatalogueOptions, type CatalogueResult } from '../../src/db/evidence-producer';
import { S3EvidenceStorage } from '../../src/db/s3-evidence-storage';
import { S3ObjectStorage } from '../../src/object-storage/s3-object-storage';
import { readKeyFile } from '../../src/db/backup-crypto';
import { restoreAndVerify } from '../../src/db/restore';
import { Database } from '../../src/db/database';
import { PostgresLedgerRecordsRepository } from '../../src/storage/postgres/ledger-records.repository';
import { adminUrl, createEphemeralDatabase, serializeRestoreSuites, withAdmin, type EphemeralDatabase } from '../helpers/database';
import { cleanupScratch, emulator, newBucket, S3_ENDPOINT, tempDir } from '../helpers/offsite-fixtures';
import { captureFor, seedLabReport, sha, type SeededReport } from '../helpers/ledger-fixtures';

serializeRestoreSuites();
describe('catalogue inventory on verified PostgreSQL restore', () => {
  let pg: EphemeralDatabase;
  let backupDir: string;
  let keyFile: string;
  beforeAll(async () => {
    pg = await createEphemeralDatabase();
    const a = await seedLabReport(pg.adminUrl, 'syn-inventory-a');
    const b = await seedLabReport(pg.adminUrl, 'syn-inventory-b');
    const db = new Database({ url: pg.appUrl, ssl: 'disable' });
    try {
      await new PostgresLedgerRecordsRepository(db).insertCapture(a.tenantId, 'syn-capturer', captureFor(a));
    } finally {
      await db.onModuleDestroy();
    }
    await withAdmin(pg.adminUrl, async (c) => {
      await c.query('UPDATE reports SET deleted_at=now() WHERE tenant_id=$1 AND id=$2', [b.tenantId, b.reportId]);
      for (const report of [a, b])
        for (const kind of ['vcf', 'structured']) {
          const id = randomUUID();
          await c.query(
            "INSERT INTO reports (id,tenant_id,created_by,patient_id,type,original_filename,size_bytes,content_type,sha256,storage_key,uploaded_at) VALUES ($1,$2,'syn-author',$3,$4,'synthetic.txt',1,$5,$6,$7,now())",
            [id, report.tenantId, report.patientId, kind, kind === 'vcf' ? 'text/plain' : 'application/json', sha('x'), 'reports/' + id],
          );
        }
      await c.query("INSERT INTO reports (tenant_id,created_by,patient_id,type,original_filename,size_bytes) VALUES ($1,'syn-author',$2,'vcf','pending.vcf',1)", [
        a.tenantId,
        a.patientId,
      ]);
      // Cross a real keyset boundary with numeric seq values; lexical ordering silently loses rows.
      await c.query(
        "INSERT INTO reports (tenant_id,created_by,patient_id,type,original_filename,size_bytes,content_type,sha256,storage_key,uploaded_at) SELECT $1,'syn-author',$2,'vcf','synthetic.vcf',1,'text/x-vcf',$3,'reports/'||gen_random_uuid()::text,now() FROM generate_series(1,101)",
        [a.tenantId, a.patientId, sha('x')],
      );
    });
    const dir = tempDir('evidence-fixture-');
    keyFile = join(dir, 'backup.key');
    await generateKeyFile(keyFile);
    backupDir = (await createBackup({ adminUrl: pg.adminUrl, destDir: dir, keyFile })).dir;
    // A later completed row belongs to live state, not this backup's membership.
    await seedLabReport(pg.adminUrl, 'syn-inventory-later');
  }, 120_000);
  afterAll(async () => {
    await pg?.drop();
    cleanupScratch();
  });

  it('covers every completed type/capture and soft deletion from the backup, excluding later live changes', async () => {
    let inventory: EvidenceInventory | undefined;
    const report = await restoreAndVerify({
      adminUrl: adminUrl(),
      backupDir,
      keyFile,
      afterVerified: async (url) => {
        inventory = await readEvidenceInventory(url, new EvidenceBudget());
      },
    });
    expect(report.checks.filter((check) => !check.ok)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.kept).toBe(false);
    expect(inventory!.references).toHaveLength(108);
    expect(inventory!.uncompletedRegistrations).toBe(1);
    expect(inventory!.restoredDatabaseBytes).toBeGreaterThan(0);
    expect(new Set(inventory!.references.map((r) => r.tenantId))).toEqual(new Set(['syn-inventory-a', 'syn-inventory-b']));
    expect(inventory!.references.filter((r) => r.kind === 'text')).toHaveLength(1);
    expect(inventory!.references.filter((r) => r.dbVersion === null && r.kind !== 'text')).toHaveLength(105);
  }, 120_000);
  it('refuses the restricted app inventory role and bounded inventory overflow', async () => {
    await expect(readEvidenceInventory(pg.appUrl, new EvidenceBudget())).rejects.toMatchObject({ code: 'inventory' });
    await expect(readEvidenceInventory(pg.adminUrl, new EvidenceBudget({ references: 1 }))).rejects.toMatchObject({ code: 'limit' });
  });
  it('does not run inventory after failed authentication, and cleans a restore after callback failure', async () => {
    const wrong = join(tempDir(), 'wrong.key');
    await generateKeyFile(wrong);
    const callback = jest.fn();
    expect((await restoreAndVerify({ adminUrl: adminUrl(), backupDir, keyFile: wrong, afterVerified: callback })).ok).toBe(false);
    expect(callback).not.toHaveBeenCalled();
    const count = async () => (await withAdmin(adminUrl(), (c) => c.query("SELECT count(*)::int AS n FROM pg_database WHERE datname LIKE 'restore_check_%'"))).rows[0].n;
    const before = await count();
    const failed = await restoreAndVerify({
      adminUrl: adminUrl(),
      backupDir,
      keyFile,
      afterVerified: async () => {
        throw new Error('synthetic callback refusal');
      },
    });
    expect(failed.ok).toBe(false);
    expect(await count()).toBe(before);
  }, 120_000);
});

const both = Boolean(process.env.TEST_S3_ENDPOINT);
if (!both) process.stderr.write('[jest] NOT RUNNING: test/db/evidence-catalogue producer (also needs TEST_S3_ENDPOINT)\n');
const producerSuite = both ? describe : describe.skip;
const decorate = (s: EvidenceStorage, overrides: Partial<EvidenceStorage>): EvidenceStorage => ({
  bucket: s.bucket,
  prefix: s.prefix,
  get: s.get.bind(s),
  keys: s.keys.bind(s),
  versions: s.versions.bind(s),
  put: s.put.bind(s),
  ...overrides,
});
producerSuite('catalogue production on PostgreSQL and Moto (metadata/protocol only)', () => {
  let pg: EphemeralDatabase;
  let source: S3EvidenceStorage;
  let destination: S3EvidenceStorage;
  let base: CatalogueOptions;
  let storage: S3ObjectStorage;
  let pinned: SeededReport;
  let textKey: string;
  const evidence: CatalogueResult['metrics'][] = [];
  const checks: { name: string; passed: boolean }[] = [];
  let physicalBytes = 0;
  const pdf = Buffer.from('%PDF-1.4\n% synthetic catalogue bytes\n');
  const text = 'synthetic \u{1f9ea} text';
  const policy: EvidencePolicy = { mode: 'COMPLIANCE', retainUntil: new Date(Math.floor((Date.now() + 86400_000) / 1000) * 1000).toISOString(), encryption: 'AES256', keyId: null };
  beforeAll(async () => {
    pg = await createEphemeralDatabase();
    const bucket = 'evidence-source-' + randomUUID();
    await emulator().send(new CreateBucketCommand({ Bucket: bucket }));
    await emulator().send(new PutBucketVersioningCommand({ Bucket: bucket, VersioningConfiguration: { Status: 'Enabled' } }));
    const copy = await newBucket();
    const settings = { region: 'us-east-1', endpoint: S3_ENDPOINT, credentials: { accessKeyId: 'syn-evidence-ops', secretAccessKey: 'synthetic-only' } };
    source = new S3EvidenceStorage({ ...settings, bucket, prefix: 'reports/' });
    destination = new S3EvidenceStorage({ ...settings, bucket: copy, prefix: 'catalogues/' });
    storage = new S3ObjectStorage(emulator(), bucket);
    async function uploaded(tenant: string, type: 'lab-pdf' | 'vcf' | 'structured', bytes: Buffer, pinnedVersion = true): Promise<SeededReport> {
      const patientId = randomUUID();
      const reportId = randomUUID();
      const key = 'reports/' + reportId;
      const contentType = type === 'lab-pdf' ? 'application/pdf' : type === 'vcf' ? 'text/x-vcf' : 'application/json';
      const stored = await storage.putObject(key, bytes, contentType);
      await withAdmin(pg.adminUrl, async (c) => {
        await c.query("INSERT INTO patients (id,tenant_id,created_by,label) VALUES ($1,$2,'syn-author',$3)", [patientId, tenant, 'SYN-' + reportId]);
        await c.query(
          "INSERT INTO reports (id,tenant_id,created_by,patient_id,type,original_filename,size_bytes,content_type,sha256,storage_key,uploaded_at,object_version,uploaded_by) VALUES ($1,$2,'syn-author',$3,$4,'synthetic.txt',$5,$6,$7,$8,now(),$9,'syn-author')",
          [reportId, tenant, patientId, type, bytes.length, contentType, byteDigest(bytes), key, pinnedVersion ? stored.version : null],
        );
      });
      return { tenantId: tenant, uploader: 'syn-author', patientId, reportId, pdfSha256: byteDigest(bytes), objectVersion: stored.version!, storageKey: key };
    }
    pinned = await uploaded('syn-producer-a', 'lab-pdf', pdf);
    const soft = await uploaded('syn-producer-b', 'lab-pdf', pdf);
    await withAdmin(pg.adminUrl, (c) => c.query('UPDATE reports SET deleted_at=now() WHERE tenant_id=$1 AND id=$2', [soft.tenantId, soft.reportId]));
    const unpinnedVcf = await uploaded('syn-producer-a', 'vcf', Buffer.from('##fileformat=VCFv4.2\n'), false);
    await storage.putObject(unpinnedVcf.storageKey, Buffer.from('larger unrelated current VCF bytes'.repeat(4)), 'text/x-vcf');
    await uploaded('syn-producer-b', 'structured', Buffer.from('{"synthetic":true}'), false);
    textKey = 'reports/' + pinned.reportId + '/text/synthetic';
    await storage.putObject(textKey, Buffer.from(text), 'text/plain; charset=utf-8');
    const db = new Database({ url: pg.appUrl, ssl: 'disable' });
    try {
      await new PostgresLedgerRecordsRepository(db).insertCapture(
        pinned.tenantId,
        'syn-capturer',
        captureFor(pinned, text, { textStorageKey: textKey, textScalars: [...text].length }),
      );
    } finally {
      await db.onModuleDestroy();
    }
    await storage.putObject(textKey, Buffer.from('different latest bytes'), 'text/plain; charset=utf-8');
    await storage.putObject('reports/orphan/text/unreferenced', Buffer.from('orphan'), 'text/plain; charset=utf-8');
    const scratch = tempDir('evidence-production-');
    const backupKeyFile = join(scratch, 'backup.key');
    const catalogueKeyFile = join(scratch, 'catalogue.key');
    await generateKeyFile(backupKeyFile);
    await generateKeyFile(catalogueKeyFile);
    const backup = await createBackup({ adminUrl: pg.adminUrl, destDir: scratch, keyFile: backupKeyFile });
    physicalBytes = Number((await withAdmin(pg.adminUrl, (c) => c.query('SELECT pg_database_size(current_database())::text AS n'))).rows[0].n);
    base = { adminUrl: adminUrl(), backupDir: backup.dir, backupKeyFile, catalogueKeyFile, source, destination, policy, generation: 'healthy' };
  }, 120_000);
  afterAll(async () => {
    if (pg) await pg.drop();
    source?.destroy();
    destination?.destroy();
    cleanupScratch();
    if (both) {
      const profile = process.env.TEST_STORAGE === 'postgres' ? (process.env.TEST_OBJECT_STORAGE === 's3' ? 'postgres-s3' : 'postgres') : 'memory';
      const dir = join(__dirname, '../../test-results');
      mkdirSync(dir, { recursive: true });
      // Whitelisted aggregates only. Never serialize catalogue/binding/keys or test configuration.
      writeFileSync(
        join(dir, 'evidence-catalogue-' + profile + '.json'),
        JSON.stringify(
          {
            format: 1,
            synthetic: true,
            status: checks.length === 12 ? 'passed' : 'incomplete',
            controls: checks,
            runtime: {
              node: process.version,
              platform: process.platform,
              architecture: process.arch,
              gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
              storage: 'loopback PostgreSQL/Moto; metadata only',
            },
            sourceDatabase: { bytes: physicalBytes, GB: physicalBytes / 1e9, GiB: physicalBytes / 1024 ** 3 },
            measurements: evidence,
            independentBytesRecovered: false,
            applicationRecoveryComplete: false,
          },
          null,
          2,
        ),
      );
    }
  });
  async function run(generation: string, overrides: Partial<CatalogueOptions> = {}) {
    return produceEvidenceCatalogue({ ...base, generation, ...overrides });
  }
  const pass = (name: string) => checks.push({ name, passed: true });
  async function noCompletion(generation: string) {
    const result = await destination.versions('catalogues/' + generation + '/completion.enc', {}, new EvidenceBudget());
    expect(result.versions).toHaveLength(0);
  }

  it('publishes complete retained copies, resolves historical text and resumes without another version', async () => {
    const first = await run('healthy');
    const second = await run('healthy');
    expect(first.catalogue.sources).toHaveLength(5);
    expect(first.catalogue.mappings).toHaveLength(5);
    expect(first.catalogue.orphanTextObjects).toBe(1);
    expect(first.completion).toEqual(second.completion);
    expect(first.catalogue.sources.find((s) => s.reference.kind === 'text')!.reference.scalars).toBe([...text].length);
    expect(second.metrics.volumes.writeAttempted.bytes).toBe(0);
    expect(first.metrics.volumes.requiredObjects.bytes).toBeGreaterThan(0);
    expect(first.metrics.copiedObjectsVerified).toBe(5);
    expect(first.metrics.requiredByKind['lab-pdf'].objects).toBe(2);
    expect(first.metrics.independentBytesRecovered).toBe(false);
    expect(first.metrics.applicationRecoveryComplete).toBe(false);
    evidence.push(first.metrics, second.metrics);
    pass('healthy-historical-text-and-idempotent-resume');
  }, 120_000);
  it('recovers lost checkpoint/copy/catalogue/completion PUT replies through verified discovery', async () => {
    const lost = decorate(destination, {
      put: async (...args) => {
        await destination.put(...args);
        throw new EvidenceError('storage');
      },
    });
    expect((await run('lost-replies', { destination: lost })).completion.referenceCount).toBe(5);
    pass('lost-write-replies');
  }, 120_000);
  it('resumes an interrupted copy from encrypted frozen source identities', async () => {
    let writes = 0;
    const interrupted = decorate(destination, {
      put: async (...args) => {
        if (++writes === 2) throw new EvidenceError('limit');
        await destination.put(...args);
      },
    });
    await expect(run('interrupted', { destination: interrupted })).rejects.toMatchObject({ code: 'limit' });
    await noCompletion('interrupted');
    expect((await run('interrupted')).completion.objectCount).toBe(5);
    pass('interrupted-safe-resume');
  }, 120_000);
  it('refuses missing or wrong catalogue keys and reuse of the DB key', async () => {
    const wrong = join(tempDir(), 'wrong.key');
    await generateKeyFile(wrong);
    await expect(run('healthy', { catalogueKeyFile: wrong })).rejects.toMatchObject({ code: 'integrity' });
    await expect(run('wrong-db-key', { backupKeyFile: wrong })).rejects.toMatchObject({ code: 'binding' });
    await expect(run('same-key', { catalogueKeyFile: base.backupKeyFile })).rejects.toMatchObject({ code: 'authentication' });
    await expect(run('missing-key', { catalogueKeyFile: join(tempDir(), 'absent.key') })).rejects.toMatchObject({ code: 'authentication' });
    pass('wrong-keys-and-key-separation');
  }, 120_000);
  it('refuses retention and encryption drift without publishing a completion', async () => {
    const mode = decorate(destination, {
      get: async (...args) => {
        const value = await destination.get(...args);
        return value ? { ...value, retentionMode: 'GOVERNANCE' } : value;
      },
    });
    await expect(run('bad-retention', { destination: mode })).rejects.toMatchObject({ code: 'policy' });
    await noCompletion('bad-retention');
    const encryption = decorate(destination, {
      get: async (...args) => {
        const value = await destination.get(...args);
        return value ? { ...value, encryption: 'aws:kms', keyId: 'wrong' } : value;
      },
    });
    await expect(run('bad-encryption', { destination: encryption })).rejects.toMatchObject({ code: 'policy' });
    await noCompletion('bad-encryption');
    const short = decorate(destination, {
      get: async (...args) => {
        const value = await destination.get(...args);
        return value ? { ...value, retainUntil: '2000-01-01T00:00:00Z' } : value;
      },
    });
    await expect(run('short-retention', { destination: short })).rejects.toMatchObject({ code: 'policy' });
    await noCompletion('short-retention');
    pass('retention-and-encryption-drift');
  }, 120_000);
  it('refuses an authenticated but omitted checkpoint reference against restored membership', async () => {
    const key = await readKeyFile(base.catalogueKeyFile);
    const omitted = decorate(destination, {
      get: async (...args) => {
        const value = await destination.get(...args);
        if (!value || !args[0].endsWith('checkpoint.enc')) return value;
        const checkpoint = await decryptDocument(value.bytes, key, checkpointSchema);
        const bytes = await encryptDocument({ ...checkpoint, sources: checkpoint.sources.slice(1) }, key);
        return { ...value, bytes, sha256: byteDigest(bytes) };
      },
    });
    await expect(run('healthy', { destination: omitted })).rejects.toMatchObject({ code: 'binding' });
    pass('omitted-authenticated-membership');
  }, 120_000);
  it('refuses duplicate and foreign destination mappings rather than selecting latest', async () => {
    const duplicated = decorate(destination, {
      versions: async (...args) => {
        const page = await destination.versions(...args);
        return args[0].includes('/objects/') ? { ...page, versions: [...page.versions, ...page.versions] } : page;
      },
    });
    await expect(run('healthy', { destination: duplicated })).rejects.toMatchObject({ code: 'ambiguous' });
    const foreign = decorate(destination, {
      get: async (...args) => {
        const value = await destination.get(...args);
        return value && args[0].includes('/objects/') ? { ...value, token: 'foreign' } : value;
      },
    });
    await expect(run('healthy', { destination: foreign })).rejects.toMatchObject({ code: 'integrity' });
    pass('duplicate-and-foreign-mappings');
  }, 120_000);
  it('refuses incomplete discovery without a catalogue completion', async () => {
    const truncated = decorate(destination, { versions: async () => ({ versions: [], truncated: true }) });
    await expect(run('truncated', { destination: truncated })).rejects.toMatchObject({ name: 'IncompleteEvidenceListingError' });
    await noCompletion('truncated');
    pass('incomplete-discovery');
  }, 120_000);
  it('refuses exact corrupt text bytes on resumed pinned observations', async () => {
    const corrupt = decorate(source, {
      get: async (...args) => {
        const value = await source.get(...args);
        return value && args[0] === textKey ? { ...value, bytes: Buffer.from('corrupt'), sha256: byteDigest(Buffer.from('corrupt')) } : value;
      },
    });
    await expect(run('healthy', { source: corrupt })).rejects.toMatchObject({ code: 'integrity' });
    pass('exact-text-corruption');
  }, 120_000);
  it('reruns a healthy control after metadata/mapping faults', async () => {
    const result = await run('healthy-after-faults');
    expect(result.completion.referenceCount).toBe(5);
    evidence.push(result.metrics);
    pass('healthy-after-faults');
  }, 120_000);
  it('refuses valid text bytes when the restored capture scalar count is wrong', async () => {
    const key = 'reports/' + pinned.reportId + '/text/wrong-scalars';
    await storage.putObject(key, Buffer.from(text), 'text/plain; charset=utf-8');
    const db = new Database({ url: pg.appUrl, ssl: 'disable' });
    try {
      await new PostgresLedgerRecordsRepository(db).insertCapture(
        pinned.tenantId,
        'syn-capturer',
        captureFor(pinned, text, { textStorageKey: key, textScalars: [...text].length + 1, popplerVersion: '26.03.1' }),
      );
    } finally {
      await db.onModuleDestroy();
    }
    const dir = (await createBackup({ adminUrl: pg.adminUrl, destDir: tempDir(), keyFile: base.backupKeyFile })).dir;
    await expect(run('wrong-scalars', { backupDir: dir })).rejects.toMatchObject({ code: 'missing' });
    await noCompletion('wrong-scalars');
    pass('wrong-restored-scalar-count');
  }, 120_000);
  it('refuses a missing exact pinned PDF even when a latest substitute exists', async () => {
    await storage.putObject(pinned.storageKey, pdf, 'application/pdf');
    await emulator().send(new DeleteObjectCommand({ Bucket: source.bucket, Key: pinned.storageKey, VersionId: pinned.objectVersion }));
    await expect(run('missing-pin')).rejects.toMatchObject({ code: 'missing' });
    await noCompletion('missing-pin');
    pass('missing-pin-despite-latest');
  }, 120_000);
});
