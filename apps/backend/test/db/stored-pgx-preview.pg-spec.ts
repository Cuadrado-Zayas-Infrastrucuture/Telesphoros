import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { startFakeIdp, DEFAULT_USERS, type FakeIdp } from '@telesphoros/fake-idp';
import type { EvaluationDto } from '@telesphoros/shared-types';
import { CognitoTokenVerifier } from '../../src/auth/cognito-token-verifier';
import { Database } from '../../src/db/database';
import { createTestApp, usingS3 } from '../helpers/app';
import { createEphemeralDatabase, type EphemeralDatabase } from '../helpers/database';
import { fixturePdf, LabPipeline, type Person } from '../helpers/lab-pipeline';
import { bearer } from '../helpers/tokens';

const root = resolve(__dirname, '../../../..');
const clinician = 'Practitioner/synthetic-clinician';
const binding = { tenantId: 'synthetic-office', patientId: 'pat_000000000000000000000001', fhirPatient: 'patient-a', issuer: 'http://127.0.0.1:8301/fhir' };
interface Resource {
  resourceType: string;
  [key: string]: unknown;
}
interface Preview {
  history?: { evaluationId: string; state: string; current: boolean; events: Array<{ kind: string }>; revision: string };
  withheld?: boolean;
  schemaValid?: boolean;
  bundle?: { entry: Array<{ resource: Resource }> };
  profile?: Array<{ gene: string; result: string }>;
}
// The async child leaves this process free to serve actual authenticated HTTP requests.
function preview(config: unknown, selection: unknown): Promise<Preview> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [resolve(root, 'packages/smart-pilot/test/run-stored-reader.mjs')], {
      cwd: root,
      env: { ...process.env, NODE_ENV: 'test' },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 15_000,
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.resume(); // Never surface credential-bearing exceptions.
    child.on('error', () => reject(new Error('Stored preview process failed')));
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error('Stored preview process failed'));
      try {
        resolveResult(JSON.parse(output) as Preview);
      } catch {
        reject(new Error('Invalid preview response'));
      }
    });
    child.stdin.end(JSON.stringify({ config, selection, clinician, binding }));
  });
}

describe('stored synthetic PGx: real API, signed identity and PostgreSQL', () => {
  let db: EphemeralDatabase;
  let app: NestExpressApplication;
  let idp: FakeIdp;
  let lab: LabPipeline;
  let writer: Person;
  let reviewer: Person;
  let config: {
    mode: string;
    apiBaseUrl: string;
    issuer: string;
    clientId: string;
    sourcePdf?: { storageOrigin: string };
    readers: Array<{ ehrIssuer: string; clinician: string; subject: string; tenantId: string; token: string }>;
  };
  const requests: string[] = [];
  const tenant = `stored-${randomUUID().slice(0, 8)}`;
  beforeAll(async () => {
    // Build the actual separately runnable connector, not a test-only copy of its mapper.
    await promisify(execFile)('pnpm', ['--filter', '@telesphoros/smart-pilot', 'build'], { cwd: root, timeout: 45_000 });
    db = await createEphemeralDatabase();
    idp = await startFakeIdp({ port: 0 });
    const verifier = new CognitoTokenVerifier({ issuer: idp.issuer, clientId: 'fake-client-id' });
    app = await createTestApp({ postgresUrl: db.appUrl, labReportPipeline: true, tokenVerifier: verifier });
    app.getHttpServer().on('request', (req: { method: string }) => requests.push(req.method));
    lab = new LabPipeline(app, db.adminUrl, tenant);
    const person = async (index: number): Promise<Person> => {
      const user = DEFAULT_USERS[index]!;
      return { sub: user.sub, token: await idp.mintAccessToken({ user: { ...user, groups: [...user.groups.filter((g) => !g.startsWith('tenant:')), `tenant:${tenant}`] } }) };
    };
    writer = await person(0);
    reviewer = await person(6);
    const address = app.getHttpServer().address() as { port: number };
    config = {
      mode: 'stored-synthetic',
      apiBaseUrl: `http://127.0.0.1:${address.port}/api/v1`,
      issuer: idp.issuer,
      clientId: 'fake-client-id',
      ...(usingS3() ? { sourcePdf: { storageOrigin: new URL(process.env.TEST_S3_ENDPOINT!).origin } } : {}),
      readers: [{ ehrIssuer: binding.issuer, clinician, subject: writer.sub, tenantId: tenant, token: writer.token }],
    };
  }, 60_000);
  afterAll(async () => {
    await app?.close();
    await idp?.stop();
    await db?.drop();
  });
  const seed = async () => {
    const s = await lab.reviewedCapture(fixturePdf('D01'), { clinician: writer, reviewer });
    const evaluation = (await lab.evaluate(writer, s.reportId, { captureId: s.captureId, acceptanceId: s.acceptanceId }).expect(201)).body as EvaluationDto;
    const patient = (await lab.api().get(`/api/v1/patients/${s.patientId}`).set(bearer(writer.token)).expect(200)).body as { id: string; label: string };
    return { ...s, evaluation, selection: { patientId: patient.id, label: patient.label, evaluationId: evaluation.id } };
  };
  const counts = async () => ({ evaluations: await lab.count('evaluations', 'tenant_id = $1', [tenant]), ledger: await lab.count('ledger_events', 'tenant_id = $1', [tenant]) });

  it('reads current stored results without writes under the restricted application role', async () => {
    const s = await seed();
    const role = await app.get(Database).withTenant(tenant, async (c) => (await c.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user')).rows[0]);
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
    const before = await counts();
    requests.length = 0;
    const result = await preview(config, s.selection);
    expect(result.withheld).toBeUndefined();
    expect(result.schemaValid).toBe(true);
    expect(result.profile?.map((g) => g.gene)).toEqual(['CYP2B6', 'CYP2C19']);
    expect(result.bundle?.entry.filter((e) => e.resource.resourceType === 'Observation')).toHaveLength(4);
    expect(requests).toEqual(Array(usingS3() ? 10 : 9).fill('GET'));
    if (usingS3()) {
      const document = result.bundle?.entry.find((e) => e.resource.resourceType === 'DocumentReference')?.resource;
      const content = document?.content as { attachment: { data: string; size: number; url?: string } }[];
      expect(Buffer.from(content[0]!.attachment.data, 'base64')).toEqual(fixturePdf('D01'));
      expect(content[0]!.attachment.url).toBeUndefined();
      expect(document?.extension).toContainEqual(expect.objectContaining({ valueString: s.upload.version }));
    }
    expect(await counts()).toEqual(before);
    expect(JSON.stringify(result)).not.toMatch(/Q intermediate\.|R intermediate-normal\.|access_token|storageKey/);
  }, 30_000);

  it('refuses cross-tenant, cross-patient and forged credentials with a success control', async () => {
    const s = await seed();
    expect((await preview(config, s.selection)).schemaValid).toBe(true);
    const foreign = { ...DEFAULT_USERS[0]!, groups: ['clinician', 'tenant:foreign-stored'] };
    const foreignConfig = { ...config, readers: [{ ...config.readers[0]!, tenantId: 'foreign-stored', token: await idp.mintAccessToken({ user: foreign }) }] };
    expect(await preview(foreignConfig, s.selection)).toEqual({ withheld: true });
    const other = await seed();
    expect(await preview(config, { ...s.selection, patientId: other.patientId, label: other.selection.label })).toEqual({ withheld: true });
    const forged = { ...config, readers: [{ ...config.readers[0]!, token: `${writer.token.slice(0, -12)}invalidtoken` }] };
    expect(await preview(forged, s.selection)).toEqual({ withheld: true });
  }, 30_000);

  it('does not fall back when a new current evaluation is retracted', async () => {
    const s = await seed();
    expect((await preview(config, s.selection)).schemaValid).toBe(true);
    const newer = (await lab.decide(reviewer, s.captureId, { decision: 'accepted' }).expect(201)).body as { id: string };
    const next = (await lab.evaluate(writer, s.reportId, { captureId: s.captureId, acceptanceId: newer.id }).expect(201)).body as EvaluationDto;
    expect(await preview(config, s.selection)).toMatchObject({ withheld: true, bundle: null, profile: [], schemaValid: false });
    const selection = { ...s.selection, evaluationId: next.id };
    expect((await preview(config, selection)).schemaValid).toBe(true);
    await lab.api().post(`/api/v1/evaluations/${next.id}/corrections`).set(bearer(reviewer.token)).send({ kind: 'retraction', reasonCode: 'input-misread' }).expect(201);
    expect(await preview(config, selection)).toMatchObject({ withheld: true, bundle: null, profile: [], schemaValid: false });
    expect(await preview(config, s.selection)).toMatchObject({ withheld: true, bundle: null, profile: [], schemaValid: false });
  }, 30_000);

  it('withholds when a reviewer rejects the formerly accepted capture', async () => {
    const s = await seed();
    expect((await preview(config, s.selection)).schemaValid).toBe(true);
    await lab.decide(reviewer, s.captureId, { decision: 'rejected' }).expect(201);
    expect(await preview(config, s.selection)).toMatchObject({ withheld: true, bundle: null, profile: [], schemaValid: false });
  }, 30_000);

  it('honors the existing pipeline-off guard', async () => {
    const s = await seed();
    expect((await preview(config, s.selection)).schemaValid).toBe(true);
    const disabled = await createTestApp({ postgresUrl: db.appUrl, tokenVerifier: new CognitoTokenVerifier({ issuer: idp.issuer, clientId: 'fake-client-id' }) });
    try {
      const address = disabled.getHttpServer().address() as { port: number };
      expect(await preview({ ...config, apiBaseUrl: `http://127.0.0.1:${address.port}/api/v1` }, s.selection)).toEqual({ withheld: true });
    } finally {
      await disabled.close();
    }
  }, 30_000);

  it('retrieves the pinned PDF after overwrite and refuses a deleted pinned version without fallback', async () => {
    const s = await seed();
    expect((await preview(config, s.selection)).schemaValid).toBe(true);
    if (!usingS3()) {
      // Non-HTTP in-memory links cannot enable PDF retrieval; metadata mode is still covered above.
      expect(await preview({ ...config, sourcePdf: { storageOrigin: 'http://127.0.0.1:5555' } }, s.selection)).toEqual({ withheld: true });
      return;
    }
    const newerVersion = await lab.put(s.upload.target, fixturePdf('D02'));
    expect(newerVersion).not.toBe(s.upload.version);
    const result = await preview(config, s.selection);
    const document = result.bundle?.entry.find((e) => e.resource.resourceType === 'DocumentReference')?.resource;
    const content = document?.content as { attachment: { data: string } }[];
    expect(Buffer.from(content[0]!.attachment.data, 'base64')).toEqual(fixturePdf('D01'));
    expect(document?.extension).toContainEqual(expect.objectContaining({ valueString: s.upload.version }));
    // Blast radius: only this test's newly created object version in its unique emulator bucket.
    // The synthetic source fixture can recreate it; no shared or production object is touched.
    const rows = await lab.row<{ storage_key: string }>('SELECT storage_key FROM reports WHERE tenant_id = $1 AND id = $2', [tenant, s.reportId]);
    await lab.deleteVersion(rows[0]!.storage_key, s.upload.version!);
    expect(await preview(config, s.selection)).toEqual({ withheld: true });
  }, 30_000);

  it('reads retraction, independent reinstatement and supersession history without writing or substituting evidence', async () => {
    const s = await seed();
    const initial = await preview(config, s.selection);
    expect(initial.schemaValid).toBe(true);
    const retraction = (
      await lab.api().post(`/api/v1/evaluations/${s.evaluation.id}/corrections`).set(bearer(reviewer.token)).send({ kind: 'retraction', reasonCode: 'input-misread' }).expect(201)
    ).body as { id: string };
    const before = await counts();
    requests.length = 0;
    const withdrawn = await preview(config, s.selection);
    expect(withdrawn).toMatchObject({ withheld: true, bundle: null, profile: [], history: { evaluationId: s.evaluation.id, state: 'retracted', current: false } });
    expect(withdrawn.history?.events.map((e) => e.kind)).toEqual(['retraction']);
    expect(requests).toEqual(Array(9).fill('GET'));
    expect(await counts()).toEqual(before);
    const independent = await idp.mintAccessToken({ user: { ...DEFAULT_USERS[6]!, sub: 'synthetic-independent-reinstater', groups: ['reviewer', `tenant:${tenant}`] } });
    const reinstatement = (
      await lab
        .api()
        .post(`/api/v1/evaluations/${s.evaluation.id}/corrections`)
        .set(bearer(independent))
        .send({ kind: 'reinstatement', reasonCode: 'retraction-mistaken', previousCorrectionId: retraction.id })
        .expect(201)
    ).body as { id: string };
    const restored = await preview(config, s.selection);
    expect(restored.schemaValid).toBe(true);
    expect(restored.history?.events.map((e) => e.kind)).toEqual(['retraction', 'reinstatement']);
    expect(restored.history?.revision).not.toBe(initial.history?.revision);
    const decision = (await lab.decide(reviewer, s.captureId, { decision: 'accepted' }).expect(201)).body as { id: string };
    const replacement = (await lab.evaluate(writer, s.reportId, { captureId: s.captureId, acceptanceId: decision.id }).expect(201)).body as EvaluationDto;
    await lab
      .api()
      .post(`/api/v1/evaluations/${s.evaluation.id}/corrections`)
      .set(bearer(reviewer.token))
      .send({ kind: 'supersession', reasonCode: 'input-misread', previousCorrectionId: reinstatement.id, replacementEvaluationId: replacement.id })
      .expect(201);
    const superseded = await preview(config, s.selection);
    expect(superseded).toMatchObject({ withheld: true, bundle: null, profile: [], history: { evaluationId: s.evaluation.id, state: 'superseded', current: false } });
    expect(superseded.history?.events.map((e) => e.kind)).toEqual(['retraction', 'reinstatement', 'supersession']);
    expect(JSON.stringify(superseded)).not.toContain(replacement.id);
    expect((await preview(config, { ...s.selection, evaluationId: replacement.id })).schemaValid).toBe(true);
  }, 30_000);

  it('withholds after an actual active cell dispute appears', async () => {
    const s = await seed();
    expect((await preview(config, s.selection)).schemaValid).toBe(true);
    const citation = s.evaluation.results.find((r) => r.citation)?.citation as { guidelineId: string; locator: { table: string; row: string; column: string | null } };
    expect(citation).toBeDefined();
    const { column, ...locator } = citation.locator;
    await lab
      .api()
      .post('/api/v1/cell-disputes')
      .set(bearer(reviewer.token))
      .send({ guidelineId: citation.guidelineId, locator: { ...locator, ...(column === null ? {} : { column }) }, note: 'Synthetic connector refusal test' })
      .expect(201);
    expect(await preview(config, s.selection)).toMatchObject({ withheld: true, bundle: null, profile: [], schemaValid: false });
  }, 30_000);
});
