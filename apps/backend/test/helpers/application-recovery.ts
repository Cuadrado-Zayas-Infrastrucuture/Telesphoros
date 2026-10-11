/** F3 synthetic acceptance driver; runs INSIDE the fresh recovery worker after F2 byte verification. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { S3Client } from '@aws-sdk/client-s3';
import { CLINICAL_USE, PIPELINE_SCOPE } from '@telesphoros/shared-types';
import { byteDigest, encryptDocument, EvidenceError, type EvidenceCatalogue } from '../../src/db/evidence-catalogue';
import { readKeyFile } from '../../src/db/backup-crypto';
import { readEvidenceInventory } from '../../src/db/evidence-inventory';
import { EvidenceBudget } from '../../src/db/evidence-storage';
import { RecoveryObjectStorage } from '../../src/object-storage/recovery-object-storage';
import { S3ObjectStorage } from '../../src/object-storage/s3-object-storage';
import { ObjectStorage } from '../../src/object-storage/object-storage';
import { Database } from '../../src/db/database';
import { LedgerVerifier } from '../../src/ledger/verifier';
import { createTestApp } from './app';
import { withAdmin } from './database';
import { LabPipeline, REPO_ROOT } from './lab-pipeline';
import { bearer } from './tokens';

export async function applicationAcceptance(url: string, catalogue: EvidenceCatalogue, config: { endpoint: string; catalogueKeyFile: string; applicationFault?: string }) {
  const start = performance.now();
  const apiControls: string[] = [];
  const inventory = await readEvidenceInventory(url, new EvidenceBudget());
  const client = new S3Client({ region: 'us-east-1', endpoint: config.endpoint, forcePathStyle: true, maxAttempts: 1,
    credentials: { accessKeyId: 'SYNRECOVERYAPP', secretAccessKey: 'synthetic-only' } });
  const target = new S3ObjectStorage(client, catalogue.destinationBucket, 60);
  const get = target.getObject.bind(target);
  let targetReads = 0;
  let liveFault = config.applicationFault === 'startup-missing';
  target.getObject = async (...args) => {
    targetReads++;
    const value = await get(...args);
    if (!liveFault || !value) return value;
    if (config.applicationFault === 'runtime-text' && value.contentType?.startsWith('text/plain')) {
      const bytes = Buffer.from('synthetic corruption'); return { ...value, bytes, sizeBytes: bytes.length, sha256: byteDigest(bytes) };
    }
    if (value.contentType === 'application/pdf') return undefined;
    return value;
  };
  const key = await readKeyFile(config.catalogueKeyFile);
  let encrypted = await encryptDocument(catalogue, key);
  if (config.applicationFault === 'tampered-install') { encrypted = Buffer.from(encrypted); encrypted[encrypted.length - 1] ^= 1; }
  const expected = { binding: catalogue.binding, references: inventory.references, uncompletedRegistrations: inventory.uncompletedRegistrations,
    sourceBucket: catalogue.sourceBucket, destinationBucket: catalogue.destinationBucket, destinationPrefix: catalogue.destinationPrefix };
  if (config.applicationFault === 'foreign-destination') expected.destinationBucket = 'synthetic-foreign';
  if (config.applicationFault === 'foreign-db') expected.binding = { ...expected.binding, manifestSha256: '0'.repeat(64) };
  let app: Awaited<ReturnType<typeof createTestApp>> | undefined;
  let verifier: LedgerVerifier | undefined;
  try {
    const storage = await RecoveryObjectStorage.open({ encryptedCatalogue: encrypted, catalogueKey: key, expected, target });
    const login = (name: string) => { const result = new URL(url); result.username = name; result.password = 'synthetic-f3-password'; return result.toString(); };
    const appUrl = login('f3_recovery_app'); const verifierUrl = login('f3_recovery_verifier');
    const db = new Database({ url: appUrl, ssl: 'disable' });
    try {
      await db.withTenant('syn-f3-a', async c => {
        const role = (await c.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
        assert.equal(role.rolsuper, false); assert.equal(role.rolbypassrls, false);
        assert.equal((await c.query('SELECT count(*)::int AS n FROM reports WHERE tenant_id=$1', ['syn-f3-b'])).rows[0].n, 0);
      });
    } finally { await db.onModuleDestroy(); }
    apiControls.push('restricted-login-rls');
    app = await createTestApp({ postgresUrl: appUrl, verifierUrl, labReportPipeline: true, recoveryStorage: storage });
    assert.equal(app.get(ObjectStorage), storage); // real module registration, no provider override
    const lab = new LabPipeline(app, url, 'syn-f3-a');
    const who = await lab.person('recovered-clinician', ['clinician']);
    const reader = await lab.person('recovered-reader', ['reader']);
    const other = await lab.person('recovered-other', ['clinician'], 'syn-f3-b');
    await lab.api().get('/api/v1/health').expect(200);
    await lab.api().get('/api/v1/ready').expect(200);
    apiControls.push('module-health-readiness');
    const reports = await withAdmin(url, c => c.query('SELECT id,storage_key,object_version,sha256,size_bytes,content_type,type FROM reports WHERE tenant_id=$1 AND deleted_at IS NULL ORDER BY seq', [lab.tenant]));
    const pdf = reports.rows.find(r => r.type === 'lab-pdf')!;
    const capture = (await withAdmin(url, c => c.query('SELECT id FROM report_captures WHERE tenant_id=$1 AND report_id=$2 ORDER BY seq LIMIT 1', [lab.tenant, pdf.id]))).rows[0];
    const accepts = (await withAdmin(url, c => c.query('SELECT c.id,c.report_id,a.id AS acceptance_id FROM report_captures c JOIN capture_acceptances a ON a.tenant_id=c.tenant_id AND a.capture_id=c.id WHERE c.tenant_id=$1 AND a.decision=$2 ORDER BY c.seq', [lab.tenant, 'accepted']))).rows;
    if (config.applicationFault?.startsWith('runtime-')) {
      liveFault = true;
      const path = config.applicationFault === 'runtime-text' ? `/api/v1/captures/${capture.id}/text-url` : `/api/v1/reports/${pdf.id}/download-url`;
      const refused = await lab.api().get(path).set(bearer(who.token)).expect(500);
      assert.equal(JSON.stringify(refused.body).includes('http'), false);
      if (config.applicationFault === 'runtime-text') await lab.evaluate(who, accepts[0].report_id, { captureId: accepts[0].id, acceptanceId: accepts[0].acceptance_id }).expect(500);
      throw new EvidenceError('integrity');
    }
    let linkedBytes = 0;
    for (const path of [`/api/v1/reports/${pdf.id}/download-url`, `/api/v1/captures/${capture.id}/text-url`]) {
      const beforeDenied = targetReads;
      await lab.api().get(path).expect(401);
      await lab.api().get(path).set(bearer(reader.token)).expect(403);
      await lab.api().get(path).set(bearer(other.token)).expect(404);
      assert.equal(targetReads, beforeDenied); // denied requests must not even touch file storage
      const link = (await lab.api().get(path).set(bearer(who.token)).expect(200)).body;
      const pointer = new URL(link.url);
      assert.equal(pointer.pathname.split('/')[1], catalogue.destinationBucket);
      assert.ok(pointer.searchParams.get('versionId'));
      const response = await fetch(link.url); assert.equal(response.status, 200);
      const bytes = Buffer.from(await response.arrayBuffer()); linkedBytes += bytes.length;
      const reference = catalogue.sources.find(s => s.reference.key === (path.includes('/captures/')
        ? inventory.references.find(r => r.captureId === capture.id)!.key : pdf.storage_key))!;
      assert.equal(byteDigest(bytes), reference.reference.sha256);
    }
    apiControls.push('link-authentication-roles-and-tenant', 'verified-version-links');
    for (const report of reports.rows) {
      await lab.api().get(`/api/v1/reports/${report.id}`).set(bearer(who.token)).expect(200);
      await lab.api().get(`/api/v1/reports/${report.id}`).set(bearer(other.token)).expect(404);
      const read = await storage.getObject(report.storage_key, { ...(report.object_version ? { version: report.object_version } : {}), maxBytes: Number(report.size_bytes) });
      assert.equal(read.sha256, report.sha256);
      if (report.object_version) assert.equal(read.version, report.object_version);
    }
    apiControls.push('standard-and-pdf-bytes');
    for (const item of catalogue.sources.filter(s => s.reference.kind === 'lab-pdf' && s.reference.tenantId === 'syn-f3-b')) {
      await lab.api().get(`/api/v1/reports/${item.reference.reportId}`).set(bearer(other.token)).expect(404); // soft deletion remains hidden
    }
    apiControls.push('soft-deletion');
    // Real subprocess reader + adapter + engine; compare against existing hand-written synthetic oracle.
    const golden = JSON.parse(readFileSync(join(REPO_ROOT, 'tests/report_adapter/golden.json'), 'utf8')).cases;
    for (const [i, id] of ['D01', 'D08'].entries()) {
      const seed = accepts[i];
      const response = await lab.evaluate(who, seed.report_id, { captureId: seed.id, acceptanceId: seed.acceptance_id }).expect(201);
      const want = golden.find((g: { id: string }) => g.id === id);
      assert.equal(response.body.disposition, want.disposition);
      assert.equal(response.body.actionable, false); assert.equal(response.body.clinicalUse, CLINICAL_USE); assert.equal(response.body.scope, PIPELINE_SCOPE);
      if (want.disposition === 'held') { assert.equal(response.body.holdCode, want.holdCode); assert.deepEqual(response.body.results, []); }
      else for (const result of response.body.results) {
        const expectedResult = want.engine[result.drug];
        assert.deepEqual({ outcome: result.outcome, reasonCode: result.reasonCode ?? undefined, strength: result.strength ?? undefined, recommendationText: result.recommendationText ?? undefined },
          { outcome: expectedResult.outcome, reasonCode: expectedResult.reasonCode, strength: expectedResult.strength, recommendationText: expectedResult.recommendationText });
      }
      await lab.api().get(`/api/v1/evaluations/${response.body.id}`).set(bearer(other.token)).expect(404);
    }
    apiControls.push('golden-evaluations-and-clinical-holds', 'evaluation-tenant-isolation');
    // Existing evidence identity guards still refuse writes by the app login; no admin mutation is used as proof.
    const restricted = new Database({ url: appUrl, ssl: 'disable' });
    try { await assert.rejects(restricted.withTenant(lab.tenant, c => c.query('UPDATE reports SET object_version=$1 WHERE tenant_id=$2 AND id=$3', ['changed', lab.tenant, pdf.id]), { actor: who.sub }), { code: '23000' }); }
    finally { await restricted.onModuleDestroy(); }
    apiControls.push('database-evidence-guard');
    verifier = LedgerVerifier.connect(verifierUrl);
    assert.equal((await verifier.verify(lab.tenant, { mode: 'full' })).status, 'ok');
    apiControls.push('ledger-validity');
    await assert.rejects(storage.putObject(), /read only/);
    await assert.rejects(storage.createUploadTarget(), /read only/);
    await assert.rejects(storage.getObject(pdf.storage_key, { version: 'missing-logical-pin', maxBytes: Number(pdf.size_bytes) }), /missing/);
    apiControls.push('read-only-and-exact-pin-refusal');
    const finalInventory = await readEvidenceInventory(url, new EvidenceBudget());
    assert.deepEqual(finalInventory.references, inventory.references);
    apiControls.push('unchanged-evidence-inventory');
    return { applicationRecoveryComplete: true, clinicalUseApproved: false, apiControls, linkedBytes, seconds: (performance.now() - start) / 1000 };
  } finally { await verifier?.close(); await app?.close(); client.destroy(); }
}
