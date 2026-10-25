import { randomUUID } from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { startFakeIdp, DEFAULT_USERS, type FakeIdp } from '@telesphoros/fake-idp';
import type { EvaluationDto } from '@telesphoros/shared-types';
import { CognitoTokenVerifier } from '../../src/auth/cognito-token-verifier';
import { Database } from '../../src/db/database';
import { createTestApp } from '../helpers/app';
import { createEphemeralDatabase, type EphemeralDatabase } from '../helpers/database';
import { fixturePdf, LabPipeline, type Person } from '../helpers/lab-pipeline';
import { bearer } from '../helpers/tokens';

// Explicit command only: this is NOT matched by the ordinary service-backed test tier.
// No evidence/SMART/HTTP mocks: real OpenEMR -> built pilot -> real API/PG/S3 -> built React.
const root = resolve(__dirname, '../../../..');
interface Reply {
  ok: boolean;
  step?: string;
  reads: { ehr: number; backend: number; pdf: number; tokenExchanges: number; unexpected: number };
}
let child: ChildProcess;
function browser(action: string, data: object = {}): Promise<Reply> {
  return new Promise((resolveReply, reject) => {
    const finish = (error?: Error, reply?: Reply) => {
      clearTimeout(timer);
      child.off('message', received);
      child.off('exit', exited);
      if (error) reject(error);
      else resolveReply(reply!);
    };
    const received = (reply: Reply) => finish(reply.ok ? undefined : new Error(`Synthetic workflow browser failed: ${action}/${reply.step}`), reply);
    const exited = () => finish(new Error(`Synthetic workflow browser exited: ${action}`));
    const timer = setTimeout(() => finish(new Error(`Synthetic workflow browser timed out: ${action}`)), 60000);
    child.once('message', received);
    child.once('exit', exited);
    child.send({ action, ...data });
  });
}

describe('real synthetic OpenEMR workflow acceptance (explicit opt-in)', () => {
  let db: EphemeralDatabase, app: NestExpressApplication, idp: FakeIdp, lab: LabPipeline;
  let writer: Person, reviewer: Person;
  const tenant = `workflow-${randomUUID().slice(0, 8)}`;
  const requests: string[] = [];
  beforeAll(async () => {
    if (process.env.TEST_STORAGE !== 'postgres' || process.env.TEST_OBJECT_STORAGE !== 's3') throw new Error('Workflow requires PostgreSQL and versioned S3 emulator');
    for (const key of ['TEST_DATABASE_URL', 'TEST_S3_ENDPOINT']) {
      if (new URL(process.env[key]!).hostname !== '127.0.0.1') throw new Error('Workflow requires local disposable services');
    }
    db = await createEphemeralDatabase();
    idp = await startFakeIdp({ port: 0 });
    app = await createTestApp({ postgresUrl: db.appUrl, labReportPipeline: true, tokenVerifier: new CognitoTokenVerifier({ issuer: idp.issuer, clientId: 'fake-client-id' }) });
    app.getHttpServer().on('request', (req: { method: string }) => requests.push(req.method));
    lab = new LabPipeline(app, db.adminUrl, tenant);
    const person = async (index: number): Promise<Person> => {
      const user = DEFAULT_USERS[index]!;
      return { sub: user.sub, token: await idp.mintAccessToken({ user: { ...user, groups: [...user.groups.filter((g) => !g.startsWith('tenant:')), `tenant:${tenant}`] } }) };
    };
    writer = await person(0);
    reviewer = await person(6);
    child = fork(resolve(root, 'packages/smart-pilot/openemr/workflow-browser.mjs'), [], {
      cwd: root,
      env: { ...process.env, NODE_ENV: 'test' },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
  }, 30000);
  afterAll(async () => {
    let failed = false;
    if (child?.connected) {
      try {
        await browser('close');
      } catch {
        failed = true;
      } finally {
        child.disconnect();
      }
    }
    // Blast radius: the newly generated test_<random> database only. Fixture source recreates it.
    // Shared synthetic demo data, retention policies and production resources are never touched.
    for (const cleanup of [() => app?.close(), () => idp?.stop(), () => db?.drop()]) {
      try {
        await cleanup();
      } catch {
        failed = true;
      }
    }
    if (failed) throw new Error('Synthetic workflow cleanup failed');
  }, 65000);
  const counts = async () => ({ evaluations: await lab.count('evaluations', 'tenant_id = $1', [tenant]), ledger: await lab.count('ledger_events', 'tenant_id = $1', [tenant]) });
  async function readOnly(action: string, data: object = {}) {
    const before = await counts();
    requests.length = 0;
    const reply = await browser(action, data);
    expect(requests.every((method) => method === 'GET')).toBe(true);
    if (!['offline', 'consent'].includes(action)) expect(requests.length).toBeGreaterThan(0);
    if (action === 'consent') expect(requests).toEqual([]);
    expect(await counts()).toEqual(before);
    expect(reply.reads.unexpected).toBe(0);
    process.stdout.write(`workflow PASS: ${action}; ${requests.length} backend GET requests; unchanged evaluation/ledger counts\n`);
    return reply;
  }
  it('accepts a pinned source, clears retracted/stale evidence, requires explicit replacement, and withholds missing sources and unconsented charts', async () => {
    const role = await app.get(Database).withTenant(tenant, async (c) => (await c.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user')).rows[0]);
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
    // Test setup writes are deliberately separate from the read-only connector observations.
    const s = await lab.reviewedCapture(fixturePdf('D01'), { clinician: writer, reviewer });
    const evaluation = (await lab.evaluate(writer, s.reportId, { captureId: s.captureId, acceptanceId: s.acceptanceId }).expect(201)).body as EvaluationDto;
    const patient = (await lab.api().get(`/api/v1/patients/${s.patientId}`).set(bearer(writer.token)).expect(200)).body as { id: string; label: string };
    const selection = { patientId: patient.id, label: patient.label, evaluationId: evaluation.id };
    const registration = JSON.parse(readFileSync(resolve(root, 'packages/smart-pilot/openemr/.runtime/registration.json'), 'utf8')) as { issuer: string };
    const seed = JSON.parse(readFileSync(resolve(root, 'packages/smart-pilot/openemr/.runtime/seed.json'), 'utf8')) as { clinicianUuid: string };
    const address = app.getHttpServer().address() as { port: number };
    const config = {
      mode: 'stored-synthetic',
      apiBaseUrl: `http://127.0.0.1:${address.port}/api/v1`,
      issuer: idp.issuer,
      clientId: 'fake-client-id',
      sourcePdf: { storageOrigin: new URL(process.env.TEST_S3_ENDPOINT!).origin },
      readers: [{ ehrIssuer: registration.issuer, clinician: `Practitioner/${seed.clinicianUuid}`, subject: writer.sub, tenantId: tenant, token: writer.token }],
    };
    const expected = { evaluationId: evaluation.id, version: s.upload.version };
    const initial = await readOnly('start', { registration, config, selection, pdf: fixturePdf('D01').toString('base64'), ...expected });
    expect(initial.reads.ehr).toBeGreaterThanOrEqual(2);
    expect(initial.reads.backend).toBeGreaterThanOrEqual(10);
    expect(initial.reads.pdf).toBeGreaterThanOrEqual(1);
    expect(initial.reads.tokenExchanges).toBe(1);

    // Actual browser network loss revokes the old blob, then a positive control recovers.
    await readOnly('offline');
    await readOnly('online', expected);
    const retraction = (
      await lab.api().post(`/api/v1/evaluations/${evaluation.id}/corrections`).set(bearer(reviewer.token)).send({ kind: 'retraction', reasonCode: 'input-misread' }).expect(201)
    ).body as { id: string };
    await readOnly('withheld', { state: 'retracted' });
    const independent = await idp.mintAccessToken({ user: { ...DEFAULT_USERS[6]!, sub: 'synthetic-workflow-reinstater', groups: ['reviewer', `tenant:${tenant}`] } });
    const reinstatement = (
      await lab
        .api()
        .post(`/api/v1/evaluations/${evaluation.id}/corrections`)
        .set(bearer(independent))
        .send({ kind: 'reinstatement', reasonCode: 'retraction-mistaken', previousCorrectionId: retraction.id })
        .expect(201)
    ).body as { id: string };
    await readOnly('active', expected);

    const decision = (await lab.decide(reviewer, s.captureId, { decision: 'accepted' }).expect(201)).body as { id: string };
    const replacement = (await lab.evaluate(writer, s.reportId, { captureId: s.captureId, acceptanceId: decision.id }).expect(201)).body as EvaluationDto;
    await lab
      .api()
      .post(`/api/v1/evaluations/${evaluation.id}/corrections`)
      .set(bearer(reviewer.token))
      .send({ kind: 'supersession', reasonCode: 'input-misread', previousCorrectionId: reinstatement.id, replacementEvaluationId: replacement.id })
      .expect(201);
    await readOnly('withheld', { state: 'superseded', absent: replacement.id });
    const next = { evaluationId: replacement.id, version: s.upload.version };
    await readOnly('relaunch', { selection: { ...selection, evaluationId: replacement.id }, ...next });

    // Overwrite only the new test fixture's object; the original pinned PDF must still be displayed.
    expect(await lab.put(s.upload.target, fixturePdf('D02'))).not.toBe(s.upload.version);
    await readOnly('active', next);
    const rows = await lab.row<{ storage_key: string }>('SELECT storage_key FROM reports WHERE tenant_id = $1 AND id = $2', [tenant, s.reportId]);
    // Blast radius: one synthetic version in this run's random emulator bucket; fixture D01 recreates it.
    await lab.deleteVersion(rows[0]!.storage_key, s.upload.version!);
    await readOnly('unavailable');
    await readOnly('consent');
  }, 180000);
});
