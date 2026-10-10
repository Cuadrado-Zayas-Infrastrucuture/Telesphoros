import { fork, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CreateBucketCommand, DeleteObjectCommand, GetObjectCommand, PutBucketVersioningCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createBackup } from '../../src/db/backup';
import { generateKeyFile } from '../../src/db/backup-crypto';
import { byteDigest, EvidenceError, type EvidencePolicy } from '../../src/db/evidence-catalogue';
import { produceEvidenceCatalogue } from '../../src/db/evidence-producer';
import { EvidenceBudget, listVersions, type EvidenceStorage } from '../../src/db/evidence-storage';
import { S3EvidenceStorage } from '../../src/db/s3-evidence-storage';
import { S3ObjectStorage } from '../../src/object-storage/s3-object-storage';
import { Database } from '../../src/db/database';
import { PostgresLedgerRecordsRepository } from '../../src/storage/postgres/ledger-records.repository';
import { adminUrl, createEphemeralDatabase, serializeRestoreSuites, withAdmin, type EphemeralDatabase } from '../helpers/database';
import { cleanupScratch, emulator, newBucket, S3_ENDPOINT, tempDir } from '../helpers/offsite-fixtures';
import { captureFor, type SeededReport } from '../helpers/ledger-fixtures';
import { recoveryGateway } from '../helpers/recovery-gateway';
import { prepareRecoveryRoles, recoveryTarget } from '../helpers/recovery-target';
import type { RecoveryProbeOptions } from '../helpers/independent-recovery';

serializeRestoreSuites();
const both = Boolean(process.env.TEST_S3_ENDPOINT);
if (!both) process.stderr.write('[jest] NOT RUNNING: test/db/independent-recovery (also needs TEST_S3_ENDPOINT)\n');
const suite = both ? describe : describe.skip;
suite('F2 fresh-process independent byte recovery (synthetic translated copies)', () => {
  let pg: EphemeralDatabase; let target: Awaited<ReturnType<typeof recoveryTarget>>;
  let source: S3EvidenceStorage; let copy: S3EvidenceStorage; let backupStore: S3EvidenceStorage;
  let gateway: Awaited<ReturnType<typeof recoveryGateway>>;
  let base: Omit<RecoveryProbeOptions, 'copy' | 'backup' | 'recovery'> & { endpoint: string; copyBucket: string; backupBucket: string; recoveryBucket: string };
  let sourceStorage: S3ObjectStorage; let scratch: string; let sourceBytes = 0;
  let pdf: SeededReport; let copiedPdfKey: string; let copiedPdfVersion: string;
  const measurements: unknown[] = []; const controls: { name: string; passed: boolean }[] = [];
  const pass = (name: string) => controls.push({ name, passed: true });
  const policy: EvidencePolicy = { mode: 'COMPLIANCE', retainUntil: new Date(Math.floor((Date.now() + 86400_000) / 1000) * 1000).toISOString(), encryption: 'AES256', keyId: null };
  const databases = async () => (await withAdmin(target.url, c => c.query('SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname'))).rows.map(r => r.datname);
  async function run(fault?: string, overrides: Record<string, unknown> = {}) {
    const before = await databases(); const tmp = join(scratch, 'child-' + randomUUID()); mkdirSync(tmp, { mode: 0o700 });
    const requestsBefore = gateway.requests.length;
    const result = await new Promise<{ status: string; code?: string; errorType?: string; metrics?: Record<string, unknown> }>((resolve, reject) => {
      const worker = fork(join(__dirname, '../helpers/independent-recovery-worker.cjs'), [], {
        // No ambient AWS credentials, source endpoint, local backup path or parent heap.
        env: { PATH: process.env.PATH, TMPDIR: tmp, DATABASE_SSL: 'disable', SWC_NATIVE_BINDING_CACHE: process.env.SWC_NATIVE_BINDING_CACHE }, silent: true,
      });
      const timer = setTimeout(() => { worker.kill(); reject(new Error('Fresh recovery worker timed out.')); }, 120_000);
      let message: { status: string; code?: string; errorType?: string; metrics?: Record<string, unknown> } | undefined;
      let unexpectedOutput = false;
      const outputCategories = new Set<string>();
      worker.stdout?.on('data', () => { unexpectedOutput = true; outputCategories.add('stdout'); });
      worker.stderr?.on('data', (chunk: Buffer) => {
        unexpectedOutput = true;
        // Fixed categories expose startup evidence without printing arbitrary worker data or credentials.
        const text = chunk.toString();
        outputCategories.add(text.includes('Failed to load native binding') ? 'native-binding'
          : text.includes('Cannot find module') ? 'module-not-found'
          : text.includes('Warning:') ? 'runtime-warning' : 'other-stderr');
      });
      worker.on('message', value => { message = value as typeof message; });
      worker.once('error', error => { clearTimeout(timer); reject(error); });
      worker.once('exit', code => { clearTimeout(timer); if (code !== 0 || unexpectedOutput || !message) reject(new Error(`Fresh recovery worker failed: exit=${code}, reply=${Boolean(message)}, output=${[...outputCategories].sort().join(',') || 'none'}.`)); else resolve(message); });
      worker.send({ ...base, fault, ...overrides });
    });
    expect(await databases()).toEqual(before); expect(readdirSync(tmp)).toEqual([]);
    const requests = gateway.requests.slice(requestsBefore);
    expect(requests.filter(r => r.bucket === source.bucket)).toHaveLength(0);
    expect(requests.filter(r => r.reader).every(r => r.method === 'GET')).toBe(true);
    expect(requests.filter(r => !r.reader).every(r => r.bucket === base.recoveryBucket)).toBe(true);
    if (fault === 'interrupted') expect(requests.filter(r => r.bucket === base.recoveryBucket && r.method === 'PUT' && r.status === 200)).toHaveLength(1);
    if (fault === 'lost-recovery-reply') expect(requests.filter(r => r.bucket === base.recoveryBucket && r.method === 'PUT')).toHaveLength(5);
    if (result.status === 'passed') {
      expect(requests.some(r => r.bucket === backupStore.bucket && r.pinned && r.status === 200)).toBe(true);
      expect(requests.some(r => r.bucket === copy.bucket && r.pinned && r.status === 200)).toBe(true);
      expect(requests.filter(r => r.object && r.status === 200 && r.method === 'GET').every(r => r.pinned)).toBe(true);
      expect(requests.some(r => r.bucket === base.recoveryBucket && r.pinned && r.status === 200)).toBe(true);
    }
    return result;
  }
  async function healthy(name: string, overrides: Record<string, unknown> = {}, fault?: string) {
    const result = await run(fault, overrides);
    expect(result.status).toBe('passed'); expect(result.metrics).toMatchObject({ databaseRecoveryVerified: true, independentBytesRecovered: true, applicationRecoveryComplete: false, references: 5, recoveredObjects: 5, identityMode: 'translated-test-only' });
    const kinds = result.metrics!.requiredByKind as Record<string, { objects: number }>;
    expect(kinds['lab-pdf'].objects).toBe(2); expect(kinds.text.objects).toBe(1); expect(kinds.vcf.objects).toBe(1); expect(kinds.structured.objects).toBe(1);
    measurements.push(result.metrics); pass(name);
  }
  async function refused(name: string, fault: string, code: string, overrides: Record<string, unknown> = {}) {
    const result = await run(fault, overrides); expect(result).toMatchObject({ status: 'refused', code, independentBytesRecovered: false, applicationRecoveryComplete: false });
    pass(name); return result;
  }
  beforeAll(async () => {
    if (new URL(adminUrl()).hostname !== '127.0.0.1' || new URL(S3_ENDPOINT).hostname !== '127.0.0.1') throw new Error('F2 requires owned loopback fixtures.');
    // Fresh worker resolves workspace dependencies from their normal built exports.
    execFileSync('pnpm', ['--filter', '@telesphoros/backend', 'build'], { cwd: join(__dirname, '../../../..'), timeout: 120_000, stdio: 'pipe' });
    pg = await createEphemeralDatabase(); target = await recoveryTarget();
    scratch = tempDir('f2-recovery-');
    const primaryBucket = 'f2-primary-' + randomUUID();
    await emulator().send(new CreateBucketCommand({ Bucket: primaryBucket }));
    await emulator().send(new PutBucketVersioningCommand({ Bucket: primaryBucket, VersioningConfiguration: { Status: 'Enabled' } }));
    const settings = { region: 'us-east-1', endpoint: S3_ENDPOINT, credentials: { accessKeyId: 'syn-f2-producer', secretAccessKey: 'synthetic-only' } };
    source = new S3EvidenceStorage({ ...settings, bucket: primaryBucket, prefix: 'reports/' });
    copy = new S3EvidenceStorage({ ...settings, bucket: await newBucket(), prefix: 'catalogues/' });
    backupStore = new S3EvidenceStorage({ ...settings, bucket: await newBucket(), prefix: 'backups/' });
    sourceStorage = new S3ObjectStorage(emulator(), primaryBucket, 60);
    async function uploaded(tenant: string, kind: 'lab-pdf' | 'vcf' | 'structured', bytes: Buffer, pinned: boolean) {
      const patientId = randomUUID(); const reportId = randomUUID(); const storageKey = 'reports/' + reportId;
      const contentType = kind === 'lab-pdf' ? 'application/pdf' : kind === 'vcf' ? 'text/x-vcf' : 'application/json';
      const put = await sourceStorage.putObject(storageKey, bytes, contentType);
      await withAdmin(pg.adminUrl, async c => {
        await c.query("INSERT INTO patients (id,tenant_id,created_by,label) VALUES ($1,$2,'syn-author',$3)", [patientId, tenant, 'SYN-' + reportId]);
        await c.query("INSERT INTO reports (id,tenant_id,created_by,patient_id,type,original_filename,size_bytes,content_type,sha256,storage_key,uploaded_at,object_version,uploaded_by) VALUES ($1,$2,'syn-author',$3,$4,'synthetic.txt',$5,$6,$7,$8,now(),$9,'syn-author')", [reportId, tenant, patientId, kind, bytes.length, contentType, byteDigest(bytes), storageKey, pinned ? put.version : null]);
      });
      return { tenantId: tenant, uploader: 'syn-author', patientId, reportId, pdfSha256: byteDigest(bytes), storageKey, objectVersion: put.version! };
    }
    pdf = await uploaded('syn-f2-a', 'lab-pdf', Buffer.from('%PDF-1.4\n% synthetic F2 bytes\n'), true);
    const soft = await uploaded('syn-f2-b', 'lab-pdf', Buffer.from('%PDF-1.4\n% synthetic soft-deleted\n'), true);
    await withAdmin(pg.adminUrl, c => c.query('UPDATE reports SET deleted_at=now() WHERE tenant_id=$1 AND id=$2', [soft.tenantId, soft.reportId]));
    const vcf = await uploaded('syn-f2-a', 'vcf', Buffer.from('##fileformat=VCFv4.2\n'), false);
    const structured = await uploaded('syn-f2-b', 'structured', Buffer.from('{"synthetic":true}'), false);
    const text = 'synthetic \u{1f9ea} recovery text'; const textKey = pdf.storageKey + '/text/synthetic';
    await sourceStorage.putObject(textKey, Buffer.from(text), 'text/plain; charset=utf-8');
    const db = new Database({ url: pg.appUrl, ssl: 'disable' });
    try { await new PostgresLedgerRecordsRepository(db).insertCapture(pdf.tenantId, 'syn-capturer', captureFor(pdf, text, { textStorageKey: textKey, textScalars: [...text].length })); }
    finally { await db.onModuleDestroy(); }
    // Resolve unpinned completed standard reports/text from historical bytes, never latest substitutes.
    for (const [key, type] of [[vcf.storageKey, 'text/x-vcf'], [structured.storageKey, 'application/json'], [textKey, 'text/plain; charset=utf-8']]) {
      await sourceStorage.putObject(key, Buffer.from('newer unrelated bytes'), type);
      await emulator().send(new DeleteObjectCommand({ Bucket: primaryBucket, Key: key }));
    }
    const backupKeyFile = join(scratch, 'backup.key'); const catalogueKeyFile = join(scratch, 'catalogue.key');
    await generateKeyFile(backupKeyFile); await generateKeyFile(catalogueKeyFile);
    const backup = await createBackup({ adminUrl: pg.adminUrl, destDir: scratch, keyFile: backupKeyFile });
    sourceBytes = Number((await withAdmin(pg.adminUrl, c => c.query('SELECT pg_database_size(current_database())::text AS n'))).rows[0].n);
    const manifest = JSON.parse(readFileSync(join(backup.dir, 'manifest.json'), 'utf8'));
    await prepareRecoveryRoles(target.url, manifest.privileges.roles);
    const producer = { adminUrl: adminUrl(), backupDir: backup.dir, backupKeyFile, catalogueKeyFile, source, destination: copy, policy, generation: 'healthy' };
    const first = await produceEvidenceCatalogue(producer);
    const lost: EvidenceStorage = { bucket: copy.bucket, prefix: copy.prefix, get: copy.get.bind(copy), keys: copy.keys.bind(copy), versions: copy.versions.bind(copy), put: async (...args) => { await copy.put(...args); throw new EvidenceError('storage'); } };
    await produceEvidenceCatalogue({ ...producer, destination: lost, generation: 'lost-reply' });
    let puts = 0;
    const interrupted = { ...lost, put: async (...args: Parameters<EvidenceStorage['put']>) => { if (++puts === 2) throw new EvidenceError('limit'); await copy.put(...args); } };
    await expect(produceEvidenceCatalogue({ ...producer, destination: interrupted, generation: 'partial' })).rejects.toMatchObject({ code: 'limit' });
    puts = 0;
    await expect(produceEvidenceCatalogue({ ...producer, destination: interrupted, generation: 'unfinished' })).rejects.toMatchObject({ code: 'limit' });
    await produceEvidenceCatalogue({ ...producer, generation: 'partial' });
    const item = first.catalogue.sources.find(s => s.reference.reportId === pdf.reportId && s.reference.kind === 'lab-pdf')!;
    copiedPdfKey = 'catalogues/healthy/objects/' + item.sourceId; copiedPdfVersion = first.catalogue.mappings.find(m => m.sourceId === item.sourceId)!.destinationVersion;
    const budget = new EvidenceBudget();
    for (const file of ['manifest.json', 'db.dump.enc']) await backupStore.put('backups/' + file, readFileSync(join(backup.dir, file)), 'application/octet-stream', 'synthetic-backup', policy, budget);
    const pointer = async (key: string) => ({ key, version: (await listVersions(backupStore, key, budget))[0].version });
    const recoveryBucket = await newBucket();
    gateway = await recoveryGateway(S3_ENDPOINT, [copy.bucket, backupStore.bucket], recoveryBucket);
    base = { adminUrl: target.url, backupKeyFile, catalogueKeyFile, generation: 'healthy', sourceBucket: primaryBucket, policy, endpoint: gateway.url, copyBucket: copy.bucket, backupBucket: backupStore.bucket,
      recoveryBucket, backupManifest: await pointer('backups/manifest.json'), backupArchive: await pointer('backups/db.dump.enc') };
    const reader = new S3Client({ ...settings, endpoint: gateway.url, forcePathStyle: true, maxAttempts: 1, credentials: { accessKeyId: 'SYNRECOVERYREADER', secretAccessKey: 'synthetic-only' } });
    try {
      await expect(reader.send(new GetObjectCommand({ Bucket: primaryBucket, Key: pdf.storageKey, VersionId: pdf.objectVersion }))).rejects.toMatchObject({ name: 'AccessDenied' });
      await expect(reader.send(new PutObjectCommand({ Bucket: copy.bucket, Key: 'catalogues/no', Body: 'synthetic' }))).rejects.toMatchObject({ name: 'AccessDenied' });
    } finally { reader.destroy(); }
    pass('primary-read-and-recovery-write-denied');
  }, 240_000);
  afterAll(async () => {
    source?.destroy(); copy?.destroy(); backupStore?.destroy();
    if (target) { expect(await databases()).toEqual(['postgres']); await target.stop(); }
    await pg?.drop(); await gateway?.close(); cleanupScratch();
    const profile = process.env.TEST_STORAGE === 'postgres' ? process.env.TEST_OBJECT_STORAGE === 's3' ? 'postgres-s3' : 'postgres' : 'memory';
    const dir = join(__dirname, '../../test-results'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'independent-recovery-' + profile + '.json'), JSON.stringify({ format: 1, synthetic: true, status: controls.length === 30 ? 'passed' : 'incomplete',
      controls, runtime: { node: process.version, platform: process.platform, architecture: process.arch, gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), storage: 'loopback PostgreSQL/Moto; synthetic gateway, not AWS IAM', freshProcess: true },
      sourceDatabase: { bytes: sourceBytes, GB: sourceBytes / 1e9, GiB: sourceBytes / 1024 ** 3 }, measurements, applicationRecoveryComplete: false,
      nativeReplicationVerified: false }, null, 2));
  }, 60_000);
  it('recovers every required kind including soft deletion with primary denied', async () => { await healthy('all-five-evidence-objects'); }, 120_000);
  it('recovers producer lost-reply and resumed interruption generations in fresh processes', async () => {
    await healthy('lost-copy-reply', { generation: 'lost-reply' }); await healthy('producer-safe-resume', { generation: 'partial' });
    await refused('incomplete-generation', 'partial', 'missing', { generation: 'unfinished' });
    await healthy('lost-recovery-write-reply', { recoveryPrefix: 'recovered/lost-reply/' }, 'lost-recovery-reply');
    expect((measurements.at(-1) as { volumes: { writeAttempted: { bytes: number } } }).volumes.writeAttempted.bytes).toBeGreaterThan(0);
  }, 240_000);
  it('ignores newer different destination bytes and delete markers, using exact signed versions', async () => {
    await emulator().send(new PutObjectCommand({ Bucket: copy.bucket, Key: copiedPdfKey, Body: 'newer different PDF', ContentType: 'application/pdf' }));
    await emulator().send(new DeleteObjectCommand({ Bucket: copy.bucket, Key: copiedPdfKey }));
    await sourceStorage.putObject(pdf.storageKey, Buffer.from('newer primary PDF'), 'application/pdf');
    await healthy('newer-versions-and-delete-markers');
    await emulator().send(new PutObjectCommand({ Bucket: copy.bucket, Key: copiedPdfKey, Body: 'latest substitute present', ContentType: 'application/pdf' }));
    await refused('missing-pin-despite-latest-substitute', 'missing-pinned-pdf', 'missing');
  }, 120_000);
  it.each([
    ['missing-object', 'missing'], ['text-corrupt', 'integrity'], ['tampered-catalogue', 'integrity'],
    ['duplicate-mapping', 'schema'], ['missing-mapping', 'schema'], ['foreign-mapping', 'schema'],
    ['omitted-soft-delete', 'binding'], ['stale-binding', 'binding'], ['foreign-token', 'integrity'],
    ['short-retention', 'policy'], ['wrong-encryption', 'policy'], ['interrupted', 'limit'],
  ])('refuses %s and leaves no owned DB or temporary files', async (fault, code) => { await refused(fault, fault, code, fault === 'interrupted' ? { recoveryPrefix: 'recovered/interrupted/' } : {}); }, 120_000);
  it('refuses wrong/missing catalogue keys and wrong DB decryption keys', async () => {
    const wrong = join(scratch, 'wrong.key'); await generateKeyFile(wrong);
    await refused('wrong-catalogue-key', 'wrong-key', 'authentication', { catalogueKeyFile: wrong });
    await refused('missing-catalogue-key', 'missing-key', 'authentication', { catalogueKeyFile: join(scratch, 'absent.key') });
    await refused('wrong-db-key', 'wrong-key', 'authentication', { backupKeyFile: wrong });
  }, 240_000);
  it('refuses incomplete, repeated and timed-out discovery', async () => {
    for (const fault of ['truncated', 'repeated', 'timeout']) {
      expect((await refused(fault, fault, 'limit')).errorType).toBe('IncompleteEvidenceListingError');
    }
  }, 240_000);
  it('refuses aggregate page exhaustion even after a terminal discovery page, and truncated page 1000', async () => {
    expect((await refused('terminal-cap-no-budget-for-target', 'terminal-cap', 'limit')).errorType).toBe('IncompleteEvidenceListingError');
    expect((await refused('truncated-page-1000', 'truncated-cap', 'limit')).errorType).toBe('IncompleteEvidenceListingError');
  }, 240_000);
  it('reruns healthy recovery after faults; recovery remains separate from application acceptance', async () => {
    expect(copiedPdfVersion).toBeTruthy(); await healthy('healthy-after-all-faults', { recoveryPrefix: 'recovered/interrupted/' });
    expect((measurements.at(-1) as { volumes: { writeAttempted: { bytes: number } } }).volumes.writeAttempted.bytes).toBeGreaterThan(0);
    await healthy('interrupted-recovery-safe-resume-without-rewrites', { recoveryPrefix: 'recovered/interrupted/' });
    expect((measurements.at(-1) as { volumes: { writeAttempted: { bytes: number } } }).volumes.writeAttempted.bytes).toBe(0);
  }, 120_000);
});
