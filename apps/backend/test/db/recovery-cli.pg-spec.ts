import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { arch, cpus, platform, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { PutBucketVersioningCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { parseManifest, type BackupManifestV2 } from '../../src/db/backup-manifest';
import { quoteIdent } from '../../src/db/pg-process';
import { S3ObjectStorage } from '../../src/object-storage/s3-object-storage';
import { adminUrl, createEphemeralDatabase, type EphemeralDatabase, serializeRestoreSuites, withAdmin } from '../helpers/database';
import { cleanupScratch, emulator, newBucket, S3_ENDPOINT, tempDir } from '../helpers/offsite-fixtures';
import { type Gateway, startGateway } from '../helpers/provider-gateway';
import { type PinnedPdf, verifyPinnedPdf } from '../helpers/recovery-evidence';
import { EXPECTED_ROWS, GENERATOR, seedRecovery } from '../helpers/recovery-seed';
import { prepareRecoveryRoles, recoveryTarget } from '../helpers/recovery-target';
import { assertSchemaAcceptance } from '../helpers/schema-acceptance';

serializeRestoreSuites();
const both = Boolean(process.env.TEST_S3_ENDPOINT);
if (!both) process.stderr.write('[jest] NOT RUNNING: test/db/recovery-cli (also needs TEST_S3_ENDPOINT)\n');
const suite = both ? describe : describe.skip;
const exec = promisify(execFile);
const backend = resolve(__dirname, '../..');
const cliFile = join(backend, 'dist/db/cli.js');
const preload = join(backend, 'test/helpers/recovery-cli-observe.cjs');
interface Event { phase: string; seconds: number; ok: boolean; plaintextDumpBytes?: number; encryptedArchiveBytes?: number; manifestBytes?: number }
interface Call { code: number; output: string; seconds: number; events: Event[] }
const volume = (bytes: number) => ({ bytes, GB: bytes / 1e9, GiB: bytes / 1024 ** 3 });
const withDb = (url: string, name: string) => { const u = new URL(url); u.pathname = `/${name}`; return u.toString(); };
const loopback = (url: string) => { if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) throw new Error('Recovery rehearsal requires loopback fixtures.'); };

suite('built format 2 CLI current-schema recovery rehearsal', () => {
  let source: EphemeralDatabase | undefined;
  let target: Awaited<ReturnType<typeof recoveryTarget>> | undefined;
  let gateway: Gateway | undefined;
  let storage: S3ObjectStorage;
  let key: string; let wrong: string; let backupDir: string; let remote: string; let manifest: BackupManifestV2;
  let firstCapture: Awaited<ReturnType<typeof seedRecovery>>;
  let scratch: string; let childTmp: string; let sequence = 0;
  const kept = new Set<string>();
  const controls: { name: string; passed: boolean; seconds: number }[] = [];
  const evidence: Record<string, unknown> = { generator: GENERATOR, procedureOnly: true, productionRto: null,
    databaseRecoveryVerified: false, primaryEvidenceAvailable: false, independentReportCopiesRecovered: false, applicationRecoveryComplete: false };

  async function call(args: string[], url = target!.url, fault?: string): Promise<Call> {
    const observations = join(scratch, `observations-${sequence++}.json`);
    // Public emulator credentials only. Clear inherited provider/key-file overrides before setting fixture values.
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('BACKUP_') && !['DATABASE_SSL_CA', 'NODE_OPTIONS', 'RECOVERY_REHEARSAL_FAULT'].includes(name)));
    Object.assign(env, { DATABASE_ADMIN_URL: url, DATABASE_SSL: 'disable', TMPDIR: childTmp,
      BACKUP_S3_ENDPOINT: gateway!.url, BACKUP_S3_REGION: 'us-east-1', BACKUP_S3_FORCE_PATH_STYLE: 'true',
      BACKUP_S3_UPLOAD_ACCESS_KEY_ID: 'AKUPLOADONLY', BACKUP_S3_UPLOAD_SECRET_ACCESS_KEY: 'secret-of-AKUPLOADONLY',
      BACKUP_S3_READ_ACCESS_KEY_ID: 'AKREADONLY', BACKUP_S3_READ_SECRET_ACCESS_KEY: 'secret-of-AKREADONLY',
      RECOVERY_REHEARSAL_OBSERVATIONS: observations, ...(fault ? { RECOVERY_REHEARSAL_FAULT: fault } : {}) });
    const start = performance.now();
    const result = await new Promise<{ code: number; output: string }>((resolveCall, reject) => {
      execFile(process.execPath, ['--require', preload, cliFile, ...args], { env, timeout: 120000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
        if (error && (typeof error.code !== 'number' || error.killed)) { reject(new Error('Built recovery CLI did not complete within its bounded execution.')); return; }
        resolveCall({ code: error?.code ? Number(error.code) : 0, output: stdout + stderr });
      });
    });
    expect(readdirSync(childTmp)).toEqual([]); // private download/decrypt workspaces gone after every CLI call
    return { ...result, seconds: (performance.now() - start) / 1000, events: JSON.parse(readFileSync(observations, 'utf8')) as Event[] };
  }
  const databases = async () => (await withAdmin(target!.url, c => c.query(`SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname`))).rows.map(r => r.datname);
  const restoreArgs = (from = remote, keyFile = key) => ['restore', '--from', from, ...(from.startsWith('s3:') ? ['--latest'] : []), '--key-file', keyFile];
  async function healthy() {
    const before = await databases(); const result = await call(restoreArgs());
    expect(result.code).toBe(0); expect(result.output).toContain('RESTORE VERIFIED');
    expect(await databases()).toEqual(before); return result;
  }
  async function refused(name: string, args: string[], failedCheck: RegExp, fault?: string) {
    const before = await databases(); const result = await call(args, target!.url, fault);
    expect(result.code).toBe(1); expect(result.output).toMatch(failedCheck);
    expect(result.output).not.toContain('RESTORE VERIFIED'); expect(await databases()).toEqual(before);
    controls.push({ name, passed: true, seconds: result.seconds });
    return result;
  }

  beforeAll(async () => {
    loopback(adminUrl()); loopback(S3_ENDPOINT);
    await exec('pnpm', ['--filter', '@telesphoros/backend', 'build'], { cwd: resolve(backend, '../..'), timeout: 120000, maxBuffer: 1024 * 1024 });
    scratch = tempDir('recovery-rehearsal-'); childTmp = join(scratch, 'cli-tmp'); mkdirSync(childTmp);
    gateway = await startGateway(S3_ENDPOINT, { keys: { AKUPLOADONLY: ['put'], AKREADONLY: ['get', 'list'] }, strict: true });
    const primaryBucket = await newBucket({ lock: false });
    await emulator().send(new PutBucketVersioningCommand({ Bucket: primaryBucket, VersioningConfiguration: { Status: 'Enabled' } }));
    storage = new S3ObjectStorage(emulator(), primaryBucket, 60); evidence.primaryBucket = primaryBucket;
    remote = `s3://${await newBucket()}/rehearsal`;
    source = await createEphemeralDatabase(); target = await recoveryTarget();
    firstCapture = await seedRecovery(source, storage);
    const size = await withAdmin(source.adminUrl, c => c.query(`SELECT pg_database_size(current_database())::text AS bytes, version() AS postgres,
      current_setting('fsync') AS fsync, current_setting('synchronous_commit') AS synchronous_commit`));
    evidence.sourceDatabase = volume(Number(size.rows[0].bytes));
    evidence.environment = { ...size.rows[0], bytes: undefined, node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model, memoryBytes: totalmem(), storage: 'local PostgreSQL data directories; loopback Moto S3 emulator; no live provider', sourceSsl: 'disable/loopback', targetAuthentication: 'SCRAM', gitHeadAtRun: (await exec('git', ['rev-parse', 'HEAD'], { cwd: backend })).stdout.trim() };
    evidence.rehearsalSourceSha256 = Object.fromEntries([__filename, preload, join(backend, 'test/helpers/recovery-seed.ts'), join(backend, 'test/helpers/recovery-target.ts'), join(backend, 'test/helpers/recovery-evidence.ts')].map(file => [file.slice(backend.length + 1), createHash('sha256').update(readFileSync(file)).digest('hex')]));
    evidence.builtCliSha256 = createHash('sha256').update(readFileSync(cliFile)).digest('hex');
    evidence.targetConfiguration = (await withAdmin(target.url, c => c.query(`SELECT version() AS postgres, current_setting('fsync') AS fsync, current_setting('synchronous_commit') AS synchronous_commit, current_setting('server_encoding') AS encoding`))).rows[0];
    key = join(scratch, 'backup.key'); wrong = join(scratch, 'wrong.key');
    expect((await call(['keygen', '--out', key])).code).toBe(0); expect((await call(['keygen', '--out', wrong])).code).toBe(0);
    const backup = await call(['backup', '--dest', join(scratch, 'backup'), '--key-file', key], source.adminUrl);
    expect(backup.code).toBe(0);
    const produced = /^backup written: (.+)$/m.exec(backup.output); expect(produced).not.toBeNull(); backupDir = produced![1]!;
    manifest = parseManifest(readFileSync(join(backupDir, 'manifest.json'), 'utf8')) as BackupManifestV2;
    expect(manifest.formatVersion).toBe(2); expect(manifest.migrations).toHaveLength(19);
    for (const [table, rows] of Object.entries(EXPECTED_ROWS)) expect(manifest.tables[table]?.rows).toBe(rows);
    const dump = backup.events.find(e => e.phase === 'pg_dump')!; expect(dump.plaintextDumpBytes).toBeGreaterThan(0);
    evidence.plaintextCustomDump = volume(dump.plaintextDumpBytes!); evidence.encryptedArchive = volume(manifest.dump.bytes);
    evidence.manifest = { bytes: statSync(join(backupDir, 'manifest.json')).size, backupName: backupDir.split('/').at(-1), createdAt: manifest.createdAt, formatVersion: manifest.formatVersion, migrations: manifest.migrations, tables: manifest.tables, schema: manifest.schema, encryptedSha256: manifest.dump.sha256, plaintextSha256: manifest.dump.plaintextSha256 };
    const upload = await call(['upload', '--from', backupDir, '--to', remote, '--key-file', key]); expect(upload.code).toBe(0);
    evidence.backupSeconds = backup.seconds; evidence.uploadSeconds = upload.seconds; evidence.producerPhases = [...backup.events, ...upload.events];
    // Fresh cluster has no application/ledger roles: exercise the actual built CLI refusal before provisioning.
    await refused('missing-target-roles', restoreArgs(), /FAIL\s+required roles/);
    await prepareRecoveryRoles(target.url, manifest.privileges!.roles);
  }, 180000);

  afterAll(async () => {
    // These are the only names created with --keep, registered before execution. No caller-named cleanup.
    if (target) {
      for (const name of kept) await withAdmin(target.url, c => c.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`));
      expect(await databases()).toEqual(['postgres']);
      await target.stop(); evidence.targetClusterRemoved = true;
    }
    if (source) { await source.drop(); evidence.sourceDatabaseRemoved = true; }
    if (gateway) {
      evidence.providerRequests = { uploadOnlyKeyUsed: gateway.requests.some(r => r.accessKeyId === 'AKUPLOADONLY'), readOnlyKeyUsed: gateway.requests.some(r => r.accessKeyId === 'AKREADONLY'), readOnlyKeyNeverWrote: gateway.requests.filter(r => r.accessKeyId === 'AKREADONLY').every(r => ['get', 'list'].includes(r.op)) };
      expect((evidence.providerRequests as { readOnlyKeyNeverWrote: boolean }).readOnlyKeyNeverWrote).toBe(true);
      await gateway.close();
    }
    evidence.controls = controls; evidence.allNineRehearsalControlsRecorded = controls.length === 9; evidence.recordedAt = new Date().toISOString();
    if (process.env.RECOVERY_REHEARSAL_OUTPUT) writeFileSync(process.env.RECOVERY_REHEARSAL_OUTPUT, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
    process.stdout.write('[recovery rehearsal] ' + JSON.stringify({
      sourceDatabase: evidence.sourceDatabase, plaintextCustomDump: evidence.plaintextCustomDump, encryptedArchive: evidence.encryptedArchive,
      requiredPdfBytes: (evidence.requiredPdfVersions as { bytes: number } | undefined)?.bytes,
      requiredTextBytes: (evidence.requiredCapturedText as { bytes: number } | undefined)?.bytes,
      restoreCliSeconds: evidence.restoreCliSeconds, databaseVerifiedSeconds: evidence.databaseVerifiedSeconds,
      databaseRecoveryVerified: evidence.databaseRecoveryVerified, primaryEvidenceAvailable: evidence.primaryEvidenceAvailable,
      independentReportCopiesRecovered: false, applicationRecoveryComplete: false,
      allNineRehearsalControlsRecorded: evidence.allNineRehearsalControlsRecorded,
      sourceDatabaseRemoved: evidence.sourceDatabaseRemoved, targetClusterRemoved: evidence.targetClusterRemoved,
    }) + '\n');
    cleanupScratch();
  }, 60000);

  it('restores the populated current schema via remote built CLI and verifies exact pinned primary evidence with labeled volumes/timings', async () => {
    const name = `recovery_cli_${randomBytes(6).toString('hex')}`; kept.add(name);
    const restored = await call([...restoreArgs(), '--target-db', name]);
    expect(restored.code).toBe(0); expect(restored.output).toContain('RESTORE VERIFIED');
    expect(restored.output).toMatch(/PASS\s+ledger chain/);
    const retryInventorySql = `SELECT id,tenant_id,created_by,creation_request_id,creation_request_hash FROM reports
      WHERE creation_request_id IS NOT NULL ORDER BY tenant_id,id`;
    const originalRetries = await withAdmin(source!.adminUrl, c => c.query(retryInventorySql));
    expect(originalRetries.rows).toHaveLength(3);
    const catalogStart = performance.now();
    const facts = await withAdmin(withDb(target!.url, name), async c => {
      await assertSchemaAcceptance(c);
      expect((await c.query(retryInventorySql)).rows).toEqual(originalRetries.rows);
      for (const [table, rows] of Object.entries(EXPECTED_ROWS)) expect(Number((await c.query(`SELECT count(*) AS n FROM ${quoteIdent(table)}`)).rows[0].n)).toBe(rows);
      const pdfs = (await c.query('SELECT storage_key,object_version,sha256,size_bytes FROM reports WHERE uploaded_at IS NOT NULL ORDER BY storage_key')).rows;
      const texts = (await c.query('SELECT text_storage_key,text_sha256,text_scalars FROM report_captures ORDER BY text_storage_key')).rows;
      return { pdfs, texts, databaseBytes: Number((await c.query('SELECT pg_database_size(current_database())::text AS bytes')).rows[0].bytes) };
    });
    evidence.catalogAcceptanceSeconds = (performance.now() - catalogStart) / 1000;
    const evidenceStart = performance.now(); let pdfBytes = 0; let textBytes = 0;
    const inventory = []; const textInventory = [];
    for (const pdf of facts.pdfs) {
      const fetched = await verifyPinnedPdf(storage, { key: pdf.storage_key, version: pdf.object_version, sha256: pdf.sha256, bytes: Number(pdf.size_bytes) });
      expect(fetched).toMatchObject({ version: pdf.object_version, sha256: pdf.sha256, sizeBytes: Number(pdf.size_bytes) });
      pdfBytes += fetched!.sizeBytes;
      inventory.push({ bucket: remotePrimaryBucket(), key: pdf.storage_key, version: pdf.object_version, sha256: pdf.sha256, bytes: fetched!.sizeBytes });
    }
    for (const text of facts.texts) {
      const fetched = await storage.getObject(text.text_storage_key, { maxBytes: 1024 });
      expect(fetched?.sha256).toBe(text.text_sha256); expect([...fetched!.bytes.toString('utf8')]).toHaveLength(text.text_scalars);
      textBytes += fetched!.sizeBytes;
      textInventory.push({ bucket: remotePrimaryBucket(), key: text.text_storage_key, sha256: text.text_sha256, bytes: fetched!.sizeBytes, observedVersion: fetched!.version });
    }
    evidence.primaryEvidenceCheckSeconds = (performance.now() - evidenceStart) / 1000;
    evidence.requiredPdfVersions = { count: facts.pdfs.length, ...volume(pdfBytes), inventory };
    evidence.requiredCapturedText = { count: facts.texts.length, ...volume(textBytes), inventory: textInventory, pinning: 'hash; current schema does not pin a text VersionId' };
    evidence.targetDatabase = volume(facts.databaseBytes); evidence.restoreCliSeconds = restored.seconds; evidence.restorePhases = restored.events;
    evidence.databaseVerifiedSeconds = restored.seconds + Number(evidence.catalogAcceptanceSeconds);
    evidence.databaseRecoveryVerified = true; evidence.primaryEvidenceAvailable = true;
    const archiveAndManifest = manifest.dump.bytes + statSync(join(backupDir, 'manifest.json')).size;
    const measurements = [
      { phase: 'backup-process-total', seconds: Number(evidence.backupSeconds), denominator: 'source pg_database_size (physical tables/indexes/catalogs)', bytes: Number((evidence.sourceDatabase as { bytes: number }).bytes) },
      { phase: 'upload-process-total', seconds: Number(evidence.uploadSeconds), denominator: 'encrypted archive plus signed manifest transferred to local emulator', bytes: archiveAndManifest },
      { phase: 'remote-restore-process-total', seconds: restored.seconds, denominator: 'encrypted archive plus signed manifest downloaded; includes all verification and process overhead', bytes: archiveAndManifest },
      { phase: 'database-verified-including-independent-catalog-acceptance', seconds: Number(evidence.databaseVerifiedSeconds), denominator: 'source physical database size; no report bytes restored', bytes: Number((evidence.sourceDatabase as { bytes: number }).bytes) },
      { phase: 'primary-evidence-availability', seconds: Number(evidence.primaryEvidenceCheckSeconds), denominator: 'required pinned PDFs plus hash-checked capture text read from primary; no independent copy recovery', bytes: pdfBytes + textBytes },
      ...[...(evidence.producerPhases as Event[]), ...restored.events].map(event => ({ phase: event.phase, seconds: event.seconds, denominator: event.plaintextDumpBytes ? 'plaintext custom archive bytes' : event.encryptedArchiveBytes ? 'encrypted archive bytes (upload also transfers the manifest)' : 'source physical database size (verification/cleanup) or archive plus manifest (download)', bytes: event.plaintextDumpBytes ?? event.encryptedArchiveBytes ?? (event.phase === 'download' ? archiveAndManifest : Number((evidence.sourceDatabase as { bytes: number }).bytes)) })),
    ];
    expect(restored.events.map(e => e.phase)).toEqual(expect.arrayContaining(['download', 'decrypt', 'pg_restore', 'restore-verification-and-temp-cleanup']));
    expect((evidence.producerPhases as Event[]).map(e => e.phase)).toEqual(expect.arrayContaining(['pg_dump', 'encrypt', 'upload']));
    expect(measurements.every(m => Number.isFinite(m.seconds) && m.seconds > 0 && m.bytes > 0)).toBe(true);
    evidence.measurements = measurements.map(m => ({ ...m, volume: volume(m.bytes), bytesPerSecond: m.bytes / m.seconds }));
    // This has checked primary bytes; no independent report-file backup was restored.
    expect(evidence.applicationRecoveryComplete).toBe(false);
    controls.push({ name: 'healthy-remote-database-and-primary-evidence', passed: true, seconds: restored.seconds });
  }, 120000);

  // Bucket is retained explicitly rather than introspecting the storage object's private client/config.
  function remotePrimaryBucket(): string { return String(evidence.primaryBucket); }

  it('refuses wrong keys and authenticated manifest/archive tampering, cleans up, then restores the healthy control', async () => {
    await refused('wrong-key', restoreArgs(remote, wrong), /FAIL\s+manifest signature/);
    const bucket = new URL(remote).hostname;
    const object = (file: string) => `rehearsal/${backupDir.split('/').at(-1)}/${file}`;
    const put = (file: string, body: Buffer) => emulator().send(new PutObjectCommand({ Bucket: bucket, Key: object(file), Body: body }));
    const original = readFileSync(join(backupDir, 'manifest.json'));
    try { const modified = JSON.parse(original.toString()); modified.tables.patients.rows++; await put('manifest.json', Buffer.from(JSON.stringify(modified))); await refused('tampered-manifest', restoreArgs(), /FAIL\s+manifest signature/); }
    finally { await put('manifest.json', original); }
    await healthy();
    const archive = readFileSync(join(backupDir, manifest.dump.file));
    try { const modified = Buffer.from(archive); modified[Math.floor(modified.length / 2)]! ^= 1; await put(manifest.dump.file, modified); await refused('tampered-encrypted-archive', restoreArgs(), /FAIL\s+backup file checksum/); }
    finally { await put(manifest.dump.file, archive); }
    await healthy();
  }, 120000);

  it.each(['rls', 'acl'])('refuses restored %s drift on the real target and restores a healthy positive control', async fault => {
    await refused(`restored-${fault}-drift`, restoreArgs(), fault === 'rls' ? /FAIL\s+row-level security settings/ : /FAIL\s+ownership and privileges/, fault);
    await healthy();
  }, 120000);

  it('refuses a valid signed/encrypted backup with broken ledger history and removes the refused restore', async () => {
    const dest = join(scratch, 'broken-ledger');
    await withAdmin(source!.adminUrl, async c => {
      await c.query('SET session_replication_role=replica');
      await c.query('UPDATE report_captures SET text_scalars=text_scalars+1 WHERE id=$1 AND tenant_id=$2', [firstCapture.id, firstCapture.tenant]);
    });
    let damaged: Call;
    try { damaged = await call(['backup', '--dest', dest, '--key-file', key], source!.adminUrl); }
    finally { await withAdmin(source!.adminUrl, async c => { await c.query('SET session_replication_role=replica'); await c.query('UPDATE report_captures SET text_scalars=text_scalars-1 WHERE id=$1 AND tenant_id=$2', [firstCapture.id, firstCapture.tenant]); }); }
    expect(damaged.code).toBe(0); const dir = /^backup written: (.+)$/m.exec(damaged.output)![1]!;
    await refused('broken-ledger-history', restoreArgs(dir), /FAIL\s+ledger chain/); await healthy();
  }, 120000);

  it('shows metadata-only DB recovery cannot establish report recovery: missing version and changed bytes fail evidence checks', async () => {
    const start = performance.now();
    const pdf = (evidence.requiredPdfVersions as { inventory: PinnedPdf[] }).inventory[0]!;
    // A newer version exists, yet the missing exact version must remain missing.
    await expect(verifyPinnedPdf(storage, { ...pdf, version: 'synthetic-missing-version' })).rejects.toThrow('version is unavailable');
    const latest = await storage.getObject(pdf.key, { maxBytes: GENERATOR.pdfBytes });
    expect(latest?.version).not.toBe(pdf.version); expect(latest?.sha256).not.toBe(pdf.sha256);
    // Real separately written altered version cannot satisfy the restored report's original hash.
    const changed = await storage.putObject('rehearsal/altered.pdf', Buffer.from('Synthetic altered bytes'), 'application/pdf');
    await expect(verifyPinnedPdf(storage, { ...pdf, key: 'rehearsal/altered.pdf', version: changed.version! })).rejects.toThrow('bytes do not match');
    expect(await verifyPinnedPdf(storage, pdf)).toMatchObject({ sha256: pdf.sha256, version: pdf.version });
    expect(evidence.databaseRecoveryVerified).toBe(true); expect(evidence.independentReportCopiesRecovered).toBe(false); expect(evidence.applicationRecoveryComplete).toBe(false);
    controls.push({ name: 'missing-exact-report-version-and-altered-byte-refusal-with-positive-control', passed: true, seconds: (performance.now() - start) / 1000 });
  }, 30000);
});
