import { fork, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createBackup } from '../../src/db/backup';
import { generateKeyFile } from '../../src/db/backup-crypto';
import { byteDigest, type EvidencePolicy } from '../../src/db/evidence-catalogue';
import { produceEvidenceCatalogue } from '../../src/db/evidence-producer';
import { EvidenceBudget, listVersions } from '../../src/db/evidence-storage';
import { S3EvidenceStorage } from '../../src/db/s3-evidence-storage';
import { scramVerifier } from '../../src/db/provision-logins';
import { S3ObjectStorage } from '../../src/object-storage/s3-object-storage';
import { ObjectStorage } from '../../src/object-storage/object-storage';
import { createTestApp } from '../helpers/app';
import { fixturePdf, LabPipeline } from '../helpers/lab-pipeline';
import { adminUrl, createEphemeralDatabase, serializeRestoreSuites, withAdmin, type EphemeralDatabase } from '../helpers/database';
import { cleanupScratch, emulator, newBucket, S3_ENDPOINT, tempDir } from '../helpers/offsite-fixtures';
import { recoveryGateway } from '../helpers/recovery-gateway';
import { prepareRecoveryRoles, recoveryTarget } from '../helpers/recovery-target';

serializeRestoreSuites();
const both = Boolean(process.env.TEST_S3_ENDPOINT);
if (!both) process.stderr.write('[jest] NOT RUNNING: test/db/application-recovery (also needs TEST_S3_ENDPOINT)\n');
(both ? describe : describe.skip)('F3 actual application recovery under restricted credentials', () => {
  let pg: EphemeralDatabase;
  let target: Awaited<ReturnType<typeof recoveryTarget>>;
  let source: S3EvidenceStorage;
  let copy: S3EvidenceStorage;
  let backup: S3EvidenceStorage;
  let gateway: Awaited<ReturnType<typeof recoveryGateway>>;
  let scratch: string;
  let nativeCache: string;
  let config: Record<string, unknown>;
  let sourceDatabaseBytes = 0;
  const controls: { name: string; passed: boolean }[] = [];
  const measurements: unknown[] = [];
  const pass = (name: string) => controls.push({ name, passed: true });
  const policy: EvidencePolicy = { mode: 'COMPLIANCE', retainUntil: new Date(Math.floor((Date.now() + 86400_000) / 1000) * 1000).toISOString(), encryption: 'AES256', keyId: null };
  const databases = async () =>
    (await withAdmin(target.url, (c) => c.query('SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname'))).rows.map((r) => r.datname);
  async function run(overrides: Record<string, unknown> = {}) {
    const before = await databases();
    const offset = gateway.requests.length;
    const tmp = join(scratch, 'worker-' + randomUUID());
    mkdirSync(tmp, { mode: 0o700 });
    const result = await new Promise<{
      status: string;
      code?: string;
      metrics?: Record<string, unknown>;
      application?: { applicationRecoveryComplete: boolean; clinicalUseApproved: boolean };
    }>((resolve, reject) => {
      const worker = fork(join(__dirname, '../helpers/independent-recovery-worker.cjs'), [], {
        env: { PATH: process.env.PATH, TMPDIR: tmp, DATABASE_SSL: 'disable', SWC_NATIVE_BINDING_CACHE: nativeCache },
        silent: true,
      });
      const timer = setTimeout(() => {
        worker.kill();
        reject(new Error('Fresh application recovery timed out.'));
      }, 180_000);
      let reply: Parameters<typeof resolve>[0] | undefined;
      const output = new Set<string>();
      worker.stdout?.on('data', () => output.add('stdout'));
      worker.stderr?.on('data', (chunk: Buffer) => output.add(chunk.toString().includes('Failed to load native binding') ? 'native-binding' : 'stderr'));
      worker.on('message', (value) => {
        reply = value as typeof reply;
      });
      worker.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      worker.once('exit', (code) => {
        clearTimeout(timer);
        if (code || output.size || !reply) reject(new Error(`Fresh application worker failed: exit=${code}, reply=${Boolean(reply)}, output=${[...output].join(',') || 'none'}.`));
        else resolve(reply);
      });
      worker.send({ ...config, application: true, ...overrides });
    });
    expect(await databases()).toEqual(before);
    expect(readdirSync(tmp)).toEqual([]);
    const requests = gateway.requests.slice(offset);
    expect(requests.filter((r) => r.bucket === source.bucket)).toHaveLength(0);
    expect(requests.filter((r) => r.object && r.method === 'GET' && r.status === 200).every((r) => r.pinned)).toBe(true);
    expect(requests.filter((r) => r.method === 'PUT').every((r) => r.bucket === config.recoveryBucket)).toBe(true);
    return result;
  }
  beforeAll(async () => {
    if (new URL(adminUrl()).hostname !== '127.0.0.1' || new URL(S3_ENDPOINT).hostname !== '127.0.0.1') throw new Error('F3 requires owned loopback fixtures.');
    execFileSync('pnpm', ['--filter', '@telesphoros/backend', 'build'], { cwd: join(__dirname, '../../../..'), timeout: 120_000, stdio: 'pipe' });
    pg = await createEphemeralDatabase();
    target = await recoveryTarget();
    scratch = tempDir('f3-recovery-');
    nativeCache = join(scratch, 'swc-native');
    mkdirSync(nativeCache, { mode: 0o700 });
    nativeCache = realpathSync(nativeCache);
    const settings = { region: 'us-east-1', endpoint: S3_ENDPOINT, credentials: { accessKeyId: 'synthetic-f3-producer', secretAccessKey: 'synthetic-only' } };
    const primaryBucket = await newBucket();
    source = new S3EvidenceStorage({ ...settings, bucket: primaryBucket, prefix: 'reports/' });
    copy = new S3EvidenceStorage({ ...settings, bucket: await newBucket(), prefix: 'catalogues/' });
    backup = new S3EvidenceStorage({ ...settings, bucket: await newBucket(), prefix: 'backups/' });
    const storage = new S3ObjectStorage(emulator(), primaryBucket);
    const app = await createTestApp({ labReportPipeline: true, postgresUrl: pg.appUrl, overrides: [{ provide: ObjectStorage, useValue: storage }] });
    try {
      const lab = new LabPipeline(app, pg.adminUrl, 'syn-f3-a');
      for (const id of ['D01', 'D08']) await lab.reviewedCapture(fixturePdf(id));
      const other = new LabPipeline(app, pg.adminUrl, 'syn-f3-b');
      const soft = await other.uploadedLabPdf(await other.person('synthetic-soft', ['clinician']), fixturePdf('D02'));
      await withAdmin(pg.adminUrl, (c) => c.query('UPDATE reports SET deleted_at=now() WHERE tenant_id=$1 AND id=$2', [other.tenant, soft.reportId]));
      for (const [kind, text, contentType] of [
        ['structured', '{"synthetic":"second"}', 'application/json'], // formerly a vcf row: two standard reports, so the count below is unchanged
        ['structured', '{"synthetic":true}', 'application/json'],
      ]) {
        const patient = await lab.patient(await lab.person('synthetic-standard', ['clinician']));
        const id = randomUUID();
        const objectKey = 'reports/' + id;
        const bytes = Buffer.from(text);
        await storage.putObject(objectKey, bytes, contentType);
        // Completed standard reports may legitimately have null DB pins; exercise that existing contract.
        await withAdmin(pg.adminUrl, (c) =>
          c.query(
            "INSERT INTO reports(id,tenant_id,created_by,patient_id,type,original_filename,size_bytes,content_type,sha256,storage_key,uploaded_at,object_version,uploaded_by) VALUES($1,$2,'synthetic-f3',$3,$4,'synthetic.txt',$5,$6,$7,$8,now(),NULL,'synthetic-f3')",
            [id, lab.tenant, patient, kind, bytes.length, contentType, byteDigest(bytes), objectKey],
          ),
        );
      }
      const keys = (
        await withAdmin(pg.adminUrl, (c) =>
          c.query('SELECT storage_key AS key FROM reports WHERE tenant_id=$1 UNION ALL SELECT text_storage_key AS key FROM report_captures WHERE tenant_id=$1', [lab.tenant]),
        )
      ).rows;
      for (const { key } of keys) {
        await storage.putObject(key, Buffer.from('newer unrelated synthetic bytes'), 'application/octet-stream');
        await emulator().send(new DeleteObjectCommand({ Bucket: primaryBucket, Key: key }));
      }
    } finally {
      await app.close();
    }
    const backupKeyFile = join(scratch, 'backup.key');
    const catalogueKeyFile = join(scratch, 'catalogue.key');
    await generateKeyFile(backupKeyFile);
    await generateKeyFile(catalogueKeyFile);
    const archive = await createBackup({ adminUrl: pg.adminUrl, destDir: scratch, keyFile: backupKeyFile });
    sourceDatabaseBytes = Number((await withAdmin(pg.adminUrl, (c) => c.query('SELECT pg_database_size(current_database())::text AS n'))).rows[0].n);
    const manifest = JSON.parse(readFileSync(join(archive.dir, 'manifest.json'), 'utf8'));
    await prepareRecoveryRoles(target.url, manifest.privileges.roles);
    await withAdmin(target.url, async (c) => {
      for (const [login, role] of [
        ['f3_recovery_app', 'telesphoros_app'],
        ['f3_recovery_verifier', 'telesphoros_ledger_verifier'],
      ]) {
        await c.query(
          `CREATE ROLE ${c.escapeIdentifier(login)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD ${c.escapeLiteral(scramVerifier('synthetic-f3-password'))} IN ROLE ${c.escapeIdentifier(role)}`,
        );
      }
    });
    const produced = await produceEvidenceCatalogue({
      adminUrl: adminUrl(),
      backupDir: archive.dir,
      backupKeyFile,
      catalogueKeyFile,
      source,
      destination: copy,
      policy,
      generation: 'healthy',
    });
    expect(produced.catalogue.sources).toHaveLength(7);
    // Independent copies also have newer versions/delete markers; only authenticated original pins may be read.
    for (const mapping of produced.catalogue.mappings) {
      const key = copy.prefix + 'healthy/objects/' + mapping.sourceId;
      await emulator().send(new PutObjectCommand({ Bucket: copy.bucket, Key: key, Body: 'synthetic substitute' }));
      await emulator().send(new DeleteObjectCommand({ Bucket: copy.bucket, Key: key }));
    }
    const budget = new EvidenceBudget();
    for (const file of ['manifest.json', 'db.dump.enc'])
      await backup.put(backup.prefix + file, readFileSync(join(archive.dir, file)), 'application/octet-stream', 'synthetic-backup', policy, budget);
    const pointer = async (key: string) => ({ key, version: (await listVersions(backup, key, budget))[0].version });
    const recoveryBucket = await newBucket();
    gateway = await recoveryGateway(S3_ENDPOINT, [copy.bucket, backup.bucket], recoveryBucket);
    config = {
      adminUrl: target.url,
      backupKeyFile,
      catalogueKeyFile,
      policy,
      generation: 'healthy',
      sourceBucket: primaryBucket,
      endpoint: gateway.url,
      copyBucket: copy.bucket,
      backupBucket: backup.bucket,
      recoveryBucket,
      backupManifest: await pointer('backups/manifest.json'),
      backupArchive: await pointer('backups/db.dump.enc'),
    };
    const caller = new S3Client({
      ...settings,
      endpoint: gateway.url,
      forcePathStyle: true,
      maxAttempts: 1,
      credentials: { accessKeyId: 'SYNRECOVERYAPP', secretAccessKey: 'synthetic-only' },
    });
    try {
      await expect(caller.send(new GetObjectCommand({ Bucket: primaryBucket, Key: 'reports/no', VersionId: 'no' }))).rejects.toMatchObject({ name: 'AccessDenied' });
      await expect(caller.send(new GetObjectCommand({ Bucket: copy.bucket, Key: 'catalogues/no', VersionId: 'no' }))).rejects.toMatchObject({ name: 'AccessDenied' });
      await expect(caller.send(new PutObjectCommand({ Bucket: recoveryBucket, Key: 'no', Body: 'synthetic' }))).rejects.toMatchObject({ name: 'AccessDenied' });
    } finally {
      caller.destroy();
    }
    pass('application-primary-copy-reads-and-target-writes-denied');
  }, 240_000);
  afterAll(async () => {
    source?.destroy();
    copy?.destroy();
    backup?.destroy();
    if (target) {
      expect(await databases()).toEqual(['postgres']);
      await target.stop();
    }
    await pg?.drop();
    await gateway?.close();
    cleanupScratch();
    const profile = process.env.TEST_STORAGE === 'postgres' ? (process.env.TEST_OBJECT_STORAGE === 's3' ? 'postgres-s3' : 'postgres') : 'memory';
    const dir = join(__dirname, '../../test-results');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'application-recovery-' + profile + '.json'),
      JSON.stringify(
        {
          format: 1,
          synthetic: true,
          status: controls.length === 13 ? 'passed' : 'incomplete',
          controls,
          runtime: {
            node: process.version,
            platform: process.platform,
            architecture: process.arch,
            gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
            freshProcess: true,
            storage: 'loopback PostgreSQL/Moto; synthetic gateway, not AWS IAM',
          },
          sourceDatabase: { bytes: sourceDatabaseBytes, GB: sourceDatabaseBytes / 1e9, GiB: sourceDatabaseBytes / 1024 ** 3 },
          measurements,
          applicationRecoveryComplete: controls.length === 13,
          clinicalUseApproved: false,
          nativeReplicationVerified: false,
        },
        null,
        2,
      ),
    );
  }, 60_000);
  it('serves exact authorized links, standard bytes, real evaluations and clinical holds with primary denied', async () => {
    const result = await run();
    expect(result.status).toBe('passed');
    expect(result.application).toMatchObject({ applicationRecoveryComplete: true, clinicalUseApproved: false });
    expect(result.metrics).toMatchObject({ independentBytesRecovered: true, applicationRecoveryComplete: false, references: 7, recoveredObjects: 7 });
    measurements.push({ recovery: result.metrics, application: result.application });
    pass('actual-app-api-links-evaluations-isolation-and-holds');
  }, 180_000);
  it.each([
    ['tampered-install', 'authentication'],
    ['foreign-destination', 'binding'],
    ['foreign-db', 'binding'],
    ['startup-missing', 'missing'],
    ['runtime-pdf', 'integrity'],
    ['runtime-text', 'integrity'],
  ])(
    'refuses application %s',
    async (applicationFault, code) => {
      expect(await run({ applicationFault })).toMatchObject({ status: 'refused', code, applicationRecoveryComplete: false });
      pass(applicationFault);
    },
    180_000,
  );
  it.each([
    ['missing-object', 'missing'],
    ['text-corrupt', 'integrity'],
    ['missing-mapping', 'schema'],
    ['truncated', 'limit'],
  ])(
    'never boots application after independent-copy %s',
    async (fault, code) => {
      expect(await run({ fault })).toMatchObject({ status: 'refused', code, applicationRecoveryComplete: false });
      pass(fault);
    },
    180_000,
  );
  it('reruns healthy after failures without rewriting installed evidence', async () => {
    const result = await run();
    expect(result.status).toBe('passed');
    expect(result.application?.applicationRecoveryComplete).toBe(true);
    expect((result.metrics!.volumes as { writeAttempted: { bytes: number } }).writeAttempted.bytes).toBe(0);
    measurements.push({ recovery: result.metrics, application: result.application });
    pass('healthy-safe-resume-after-faults');
  }, 180_000);
});
