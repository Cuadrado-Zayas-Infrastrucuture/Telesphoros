import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import type { PoolClient } from 'pg';
import { enqueueJob, evaluationRequest, JobQueue, PRODUCTION_JOBS } from '@telesphoros/jobs';
import { ErrorCode, evaluationRequestCreateSchema, evaluationExecutionProfileSchema } from '@telesphoros/shared-types';
import { migrateDown, migrateUp } from '../../src/db/migrator';
import { Database } from '../../src/db/database';
import type { TenantWorkOptions } from '../../src/db/database';
import { EvaluationRequestsService } from '../../src/lab-reports/evaluation-requests.service';
import { EvaluationRequestsRepository } from '../../src/storage/postgres/evaluation-requests.repository';
import { PostgresLedgerRecordsRepository } from '../../src/storage/postgres/ledger-records.repository';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';
import { acceptanceFor, captureFor, evaluationFor, seedLabReport, sha } from '../helpers/ledger-fixtures';

let pg: EphemeralDatabase;
let database: Database;
const profile = {
  version: 'evaluation-execution-profile/1' as const,
  codeArtifactSha256: sha('code'),
  executionManifestSha256: sha('self-hosted manifest'),
  knowledgeSetId: sha('knowledge'),
  recordingsSha256: sha('recordings'),
};
const service = (connection = database) => new EvaluationRequestsService(new EvaluationRequestsRepository(connection), profile);
beforeAll(async () => {
  pg = await createEphemeralDatabase();
  database = new Database({ url: pg.appUrl, ssl: 'disable' });
}, 60_000);
afterAll(async () => {
  await database?.onModuleDestroy();
  await pg?.drop();
});

async function eligible(context = { pg, database }) {
  const { pg: fixture, database: connection } = context;
  const tenantId = `syn-${randomUUID()}`;
  const sub = `syn-clinician-${randomUUID()}`;
  const report = await seedLabReport(fixture.adminUrl, tenantId);
  await withAdmin(fixture.adminUrl, async (client) => {
    await client.query(`INSERT INTO tenant_memberships (tenant_id,sub,status,roles,changed_by) VALUES ($1,$2,'active',ARRAY['clinician'],'syn-test')`, [tenantId, sub]);
  });
  const ledger = new PostgresLedgerRecordsRepository(connection);
  const capture = captureFor(report);
  const stored = await ledger.insertCapture(tenantId, report.uploader, capture);
  const acceptance = await ledger.insertAcceptance(tenantId, 'syn-reviewer', acceptanceFor(stored.record.id, capture));
  const linked = await ledger.insertPatientDecision(tenantId, 'syn-verifier', {
    reportId: report.reportId,
    expectedReport: { patientId: report.patientId, sha256: report.pdfSha256, objectVersion: report.objectVersion },
    decision: 'verified',
    method: 'person-confirmed',
    basisCode: 'no-identifier-on-report',
  });
  return {
    report,
    capture,
    linked,
    ledger,
    principal: { tenantId, sub, roles: ['clinician' as const] },
    input: { reportId: report.reportId, captureId: stored.record.id, acceptanceId: acceptance.record.id, requestId: randomUUID() },
  };
}

it('concurrent identical admissions persist exactly one request and one bound job', async () => {
  const { principal, input } = await eligible();
  const admissions = await Promise.all(Array.from({ length: 4 }, () => service().admit(principal, input)));
  expect(admissions.filter((a) => a.created)).toHaveLength(1);
  expect(new Set(admissions.map((a) => a.request.id)).size).toBe(1);
  const request = admissions[0]!.request;
  expect(request).toMatchObject({ reportId: input.reportId, captureId: input.captureId, acceptanceId: input.acceptanceId, state: 'queued', evaluationId: null });
  const stored = await database.withTenant(principal.tenantId, async (client) => {
    const requests = await client.query('SELECT id,job_id FROM evaluation_requests WHERE tenant_id=$1', [principal.tenantId]);
    const jobs = await client.query("SELECT id,payload FROM jobs WHERE tenant_id=$1 AND type='evaluations.request'", [principal.tenantId]);
    return { requests: requests.rows, jobs: jobs.rows };
  });
  expect(stored.requests).toEqual([{ id: request.id, job_id: request.jobId }]);
  expect(stored.jobs).toEqual([{ id: request.jobId, payload: { requestId: request.id } }]);
  expect(await service().get(principal, request.id)).toEqual(request);
});

it('requires string digests in the SQL profile contract, including direct database callers', async () => {
  const bad = JSON.stringify(profile).replace(`"codeArtifactSha256":"${profile.codeArtifactSha256}"`, `"codeArtifactSha256":${'1'.repeat(64)}`);
  const stored = await database.withTenant('syn-profile-validation', async (client) => {
    return (await client.query('SELECT evaluation_request_profile_valid($1::jsonb) AS valid, evaluation_request_profile_valid($2::jsonb) AS bad', [JSON.stringify(profile), bad]))
      .rows[0];
  });
  expect(stored.valid).toBe(true);
  expect(stored.bad).toBe(false);
});

async function counts(tenantId: string) {
  return database.withTenant(
    tenantId,
    async (client) =>
      (
        await client.query(
          `SELECT
    (SELECT count(*)::int FROM evaluation_requests WHERE tenant_id=$1) AS requests,
    (SELECT count(*)::int FROM jobs WHERE tenant_id=$1 AND type='evaluations.request') AS jobs`,
          [tenantId],
        )
      ).rows[0],
  );
}

it('pins provider-neutral execution manifests and refuses changed bindings under the same retry identity', async () => {
  const { principal, input } = await eligible();
  const first = await service().admit(principal, input);
  const bedrockProfile = { ...profile, executionManifestSha256: sha('Bedrock manifest') };
  const otherBackend = new EvaluationRequestsService(new EvaluationRequestsRepository(database), bedrockProfile);
  await expect(otherBackend.admit(principal, input)).rejects.toMatchObject({ status: 409 });
  expect(await counts(principal.tenantId)).toEqual({ requests: 1, jobs: 1 });
  const second = await otherBackend.admit(principal, { ...input, requestId: randomUUID() });
  expect(second.request.id).not.toBe(first.request.id);
  expect(await counts(principal.tenantId)).toEqual({ requests: 2, jobs: 2 });
  const jobs = await database.withTenant(
    principal.tenantId,
    async (client) => (await client.query("SELECT payload FROM jobs WHERE tenant_id=$1 AND type='evaluations.request'", [principal.tenantId])).rows,
  );
  expect(jobs.map((j) => j.payload)).toEqual(expect.arrayContaining([{ requestId: first.request.id }, { requestId: second.request.id }]));
  expect(jobs.every((j) => Object.keys(j.payload).join() === 'requestId')).toBe(true);
});

it('rolls back the queued job when request persistence fails, then safely retries', async () => {
  const { principal, input } = await eligible();
  await withAdmin(pg.adminUrl, async (client) => {
    await client.query(`CREATE FUNCTION zz_request_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic request write failure'; END $$`);
    await client.query('CREATE TRIGGER zz_request_fail BEFORE INSERT ON evaluation_requests FOR EACH ROW EXECUTE FUNCTION zz_request_fail()');
  });
  try {
    await expect(service().admit(principal, input)).rejects.toThrow('Synthetic request write failure');
    expect(await counts(principal.tenantId)).toEqual({ requests: 0, jobs: 0 });
  } finally {
    await withAdmin(pg.adminUrl, async (client) => {
      await client.query('DROP TRIGGER zz_request_fail ON evaluation_requests');
      await client.query('DROP FUNCTION zz_request_fail()');
    });
  }
  expect((await service().admit(principal, input)).created).toBe(true);
  expect(await counts(principal.tenantId)).toEqual({ requests: 1, jobs: 1 });
});

it('reconciles a committed admission whose COMMIT response is lost without making another job', async () => {
  const { principal, input } = await eligible();
  const original = Client.prototype.query;
  let armed = true;
  (Client.prototype as unknown as { query: unknown }).query = function (this: Client, ...args: unknown[]) {
    const result = Reflect.apply(original, this, args);
    if (args[0] === 'COMMIT' && armed) {
      armed = false;
      return Promise.resolve(result).then(() => {
        throw new Error('Synthetic lost COMMIT response');
      });
    }
    return result;
  };
  try {
    await expect(service().admit(principal, input)).rejects.toThrow('Synthetic lost COMMIT response');
  } finally {
    Client.prototype.query = original;
  }
  expect(armed).toBe(false);
  const retried = await service().admit(principal, input);
  expect(retried.created).toBe(false);
  expect(await counts(principal.tenantId)).toEqual({ requests: 1, jobs: 1 });
});

it('uses current database membership, refusing an unauthorized actor even with spoofed principal roles', async () => {
  const { principal, input } = await eligible();
  const first = await service().admit(principal, input);
  const sub = `syn-admin-${randomUUID()}`;
  await withAdmin(pg.adminUrl, async (client) => {
    await client.query(`INSERT INTO tenant_memberships (tenant_id,sub,status,roles,changed_by) VALUES ($1,$2,'active',ARRAY['admin'],'syn-test')`, [principal.tenantId, sub]);
  });
  const spoofed = { ...principal, sub };
  await expect(service().admit(spoofed, input)).rejects.toMatchObject({ status: 403 });
  await expect(service().get(spoofed, first.request.id)).rejects.toMatchObject({ status: 403 });
  expect(await counts(principal.tenantId)).toEqual({ requests: 1, jobs: 1 });
});

it('does not disclose foreign request IDs and preserves organization-owned work after requester removal', async () => {
  const one = await eligible();
  const two = await eligible();
  const first = await service().admit(one.principal, one.input);
  await expect(service().get(two.principal, first.request.id)).rejects.toMatchObject({ status: 404 });
  await expect(service().get(two.principal, randomUUID())).rejects.toMatchObject({ status: 404 });
  await expect(service().admit(two.principal, one.input)).rejects.toMatchObject({ status: 409 });
  const other = `syn-reader-${randomUUID()}`;
  await withAdmin(pg.adminUrl, async (client) => {
    await client.query(`UPDATE tenant_memberships SET status='removed',changed_by='syn-test' WHERE tenant_id=$1 AND sub=$2`, [one.principal.tenantId, one.principal.sub]);
    await client.query(`INSERT INTO tenant_memberships (tenant_id,sub,status,roles,changed_by) VALUES ($1,$2,'active',ARRAY['reader'],'syn-test')`, [
      one.principal.tenantId,
      other,
    ]);
  });
  await expect(service().get(one.principal, first.request.id)).rejects.toMatchObject({ status: 403 });
  const reader = { ...one.principal, sub: other, roles: ['reader' as const] };
  expect((await service().get(reader, first.request.id)).requestedBy).toBe(one.principal.sub);
  await expect(service().admit(reader, one.input)).rejects.toMatchObject({ status: 403 });
  expect(await counts(one.principal.tenantId)).toEqual({ requests: 1, jobs: 1 });
});

it('records the admission time from the database, even for direct SQL callers', async () => {
  const { principal, input } = await eligible();
  const stored = await database.withTenant(
    principal.tenantId,
    async (client) => {
      const basis = (await client.query('SELECT evaluation_request_basis($1,$2,$3) AS b', [input.reportId, input.captureId, input.acceptanceId])).rows[0].b;
      const id = randomUUID();
      const job = await enqueueJob(client, evaluationRequest, { requestId: id }, { idempotencyKey: `evaluation-request:${id}` });
      const before = (await client.query('SELECT clock_timestamp() AS t')).rows[0].t as Date;
      const row = (
        await client.query(
          `INSERT INTO evaluation_requests
      (id,tenant_id,requested_by,creation_request_id,report_id,capture_id,acceptance_id,basis,execution_profile,job_id,created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,'3000-01-01') RETURNING created_at`,
          [id, principal.tenantId, principal.sub, input.requestId, input.reportId, input.captureId, input.acceptanceId, JSON.stringify(basis), JSON.stringify(profile), job.jobId],
        )
      ).rows[0];
      return { before, time: row.created_at as Date };
    },
    { actor: principal.sub },
  );
  expect(stored.time.getTime()).toBeGreaterThanOrEqual(stored.before.getTime());
  expect(stored.time.getTime()).toBeLessThan(stored.before.getTime() + 5000);
});

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Existing Database boundary, paused after its real work and before its real COMMIT. */
class PausedDatabase extends Database {
  readonly reached = gate();
  readonly release = gate();
  override withTenant<T>(tenantId: string, work: (client: PoolClient) => Promise<T>, options: TenantWorkOptions = {}): Promise<T> {
    return super.withTenant(
      tenantId,
      async (client) => {
        const result = await work(client);
        this.reached.resolve();
        await this.release.promise;
        return result;
      },
      options,
    );
  }
}

async function atGate(held: PausedDatabase, work: Promise<unknown>) {
  await Promise.race([
    held.reached.promise,
    work.then(() => {
      throw new Error('Work completed without reaching the transaction gate');
    }),
  ]);
}

async function blocked(applicationName: string) {
  for (let attempt = 0; attempt < 75; attempt++) {
    const waiting = await withAdmin(
      pg.adminUrl,
      async (client) =>
        (await client.query("SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND application_name=$2 AND wait_event_type='Lock'", [pg.name, applicationName])).rowCount,
    );
    if (waiting) return;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error('Expected database lock was not observed');
}

it('orders admission before a later capture rejection without silently upgrading or replaying stale evidence', async () => {
  const x = await eligible();
  const held = new PausedDatabase({ url: pg.appUrl, ssl: 'disable' });
  const reviewerName = `syn-review-${randomUUID()}`;
  const reviewer = new Database({ url: pg.appUrl, ssl: 'disable', applicationName: reviewerName });
  const pending = new EvaluationRequestsService(new EvaluationRequestsRepository(held), profile).admit(x.principal, x.input);
  void pending.catch(() => undefined);
  let changed: Promise<unknown> | undefined;
  try {
    await atGate(held, pending);
    changed = new PostgresLedgerRecordsRepository(reviewer).insertAcceptance(
      x.principal.tenantId,
      'syn-later-reviewer',
      acceptanceFor(x.input.captureId, x.capture, { decision: 'rejected' }),
    );
    void changed.catch(() => undefined);
    await blocked(reviewerName);
    held.release.resolve();
    const admitted = await pending;
    await changed;
    expect(admitted.created).toBe(true);
    expect((await service().get(x.principal, admitted.request.id)).state).toBe('queued');
    await expect(service().admit(x.principal, x.input)).rejects.toMatchObject({ status: 409 });
    expect(await counts(x.principal.tenantId)).toEqual({ requests: 1, jobs: 1 });
  } finally {
    held.release.resolve();
    await Promise.allSettled([pending, changed]);
    await held.onModuleDestroy();
    await reviewer.onModuleDestroy();
  }
});

it.each(['capture', 'patient-link'] as const)('a %s rejection that commits first is seen after the admission lock wait', async (kind) => {
  const x = await eligible();
  const reviewer = new PausedDatabase({ url: pg.appUrl, ssl: 'disable' });
  const name = `syn-admit-${randomUUID()}`;
  const waiting = new Database({ url: pg.appUrl, ssl: 'disable', applicationName: name });
  const writer = new PostgresLedgerRecordsRepository(reviewer);
  const changed =
    kind === 'capture'
      ? writer.insertAcceptance(x.principal.tenantId, 'syn-reviewer', acceptanceFor(x.input.captureId, x.capture, { decision: 'rejected' }))
      : writer.insertPatientDecision(x.principal.tenantId, 'syn-verifier', {
          reportId: x.report.reportId,
          expectedReport: { patientId: x.report.patientId, sha256: x.report.pdfSha256, objectVersion: x.report.objectVersion },
          decision: 'rejected',
          method: 'person-confirmed',
          basisCode: 'different-person',
        });
  void changed.catch(() => undefined);
  let pending: Promise<unknown> | undefined;
  try {
    await atGate(reviewer, changed);
    pending = new EvaluationRequestsService(new EvaluationRequestsRepository(waiting), profile).admit(x.principal, x.input);
    void pending.catch(() => undefined);
    await blocked(name);
    reviewer.release.resolve();
    await changed;
    await expect(pending).rejects.toMatchObject({ status: 409 });
    expect(await counts(x.principal.tenantId)).toEqual({ requests: 0, jobs: 0 });
  } finally {
    reviewer.release.resolve();
    await Promise.allSettled([changed, pending]);
    await reviewer.onModuleDestroy();
    await waiting.onModuleDestroy();
  }
});

it('reports queue progress without fabricating a clinical completion or hold', async () => {
  const isolated = await createEphemeralDatabase();
  const connection = new Database({ url: isolated.appUrl, ssl: 'disable' });
  const worker = new Client({ connectionString: isolated.workerUrl });
  try {
    await worker.connect();
    const x = await eligible({ pg: isolated, database: connection });
    const local = service(connection);
    const admitted = await local.admit(x.principal, x.input);
    const queue = new JobQueue(worker);
    const workerId = `syn-worker-${randomUUID()}`;
    const claimed = await queue.claim(workerId, { types: ['evaluations.request'], batch: 1, tenantCap: 1, leaseSeconds: 60 });
    expect(claimed.map((j) => j.id)).toEqual([admitted.request.jobId]);
    expect((await local.get(x.principal, admitted.request.id)).state).toBe('running');
    expect(await queue.fail(admitted.request.jobId, workerId, 'synthetic-retry', true)).toBe('retry');
    expect((await local.get(x.principal, admitted.request.id)).state).toBe('retry');
    // Test-only immediate eligibility, without waiting for the real backoff clock.
    await withAdmin(isolated.adminUrl, async (client) => {
      await client.query('UPDATE jobs SET run_after=clock_timestamp() WHERE id=$1', [admitted.request.jobId]);
    });
    expect((await queue.claim(workerId, { types: ['evaluations.request'], batch: 1, tenantCap: 1, leaseSeconds: 60 })).map((j) => j.id)).toEqual([admitted.request.jobId]);
    expect(await queue.succeed(admitted.request.jobId, workerId)).toBe(true);
    expect(await local.get(x.principal, admitted.request.id)).toMatchObject({ state: 'completion-missing', evaluationId: null });
    const second = await local.admit(x.principal, { ...x.input, requestId: randomUUID() });
    expect((await queue.claim(workerId, { types: ['evaluations.request'], batch: 1, tenantCap: 1, leaseSeconds: 60 })).map((j) => j.id)).toEqual([second.request.jobId]);
    expect(await queue.fail(second.request.jobId, workerId, 'synthetic-terminal-failure', false)).toBe('dead');
    expect(await local.get(x.principal, second.request.id)).toMatchObject({ state: 'dead', evaluationId: null });
  } finally {
    await worker.end();
    await connection.onModuleDestroy();
    await isolated.drop();
  }
});

it('reads a valid completion receipt before queue ACK, and refuses a mismatched evaluation receipt', async () => {
  const x = await eligible();
  const admitted = await service().admit(x.principal, x.input);
  const evaluation = await x.ledger.insertEvaluation(
    x.principal.tenantId,
    'syn-system',
    evaluationFor(x.report, x.input.captureId, x.input.acceptanceId, { patientLinkDecisionId: x.linked.record.id }),
  );
  await withAdmin(pg.adminUrl, async (client) => {
    await client.query('INSERT INTO evaluation_request_completions (request_id,tenant_id,evaluation_id) VALUES ($1,$2,$3)', [
      admitted.request.id,
      x.principal.tenantId,
      evaluation.record.id,
    ]);
  });
  expect(await service().get(x.principal, admitted.request.id)).toMatchObject({ state: 'completed', evaluationId: evaluation.record.id });
  expect(
    await database.withTenant(
      x.principal.tenantId,
      async (client) => (await client.query('SELECT state FROM jobs WHERE tenant_id=$1 AND id=$2', [x.principal.tenantId, admitted.request.jobId])).rows[0].state,
    ),
  ).toBe('queued');
  const other = await service().admit(x.principal, { ...x.input, requestId: randomUUID() });
  const report = await seedLabReport(pg.adminUrl, x.principal.tenantId);
  const capture = captureFor(report);
  const c = await x.ledger.insertCapture(x.principal.tenantId, report.uploader, capture);
  const a = await x.ledger.insertAcceptance(x.principal.tenantId, 'syn-reviewer', acceptanceFor(c.record.id, capture));
  const foreignContext = await x.ledger.insertEvaluation(x.principal.tenantId, 'syn-system', evaluationFor(report, c.record.id, a.record.id));
  await withAdmin(pg.adminUrl, async (client) => {
    await client.query('INSERT INTO evaluation_request_completions (request_id,tenant_id,evaluation_id) VALUES ($1,$2,$3)', [
      other.request.id,
      x.principal.tenantId,
      foreignContext.record.id,
    ]);
  });
  await expect(service().get(x.principal, other.request.id)).rejects.toMatchObject({ status: 503 });
});

it('enforces forced RLS, immutable requests and no worker/completion-write privileges under real restricted logins', async () => {
  const x = await eligible();
  const { request } = await service().admit(x.principal, x.input);
  const flags = await database.withTenant(
    x.principal.tenantId,
    async (client) =>
      (
        await client.query(`SELECT c.relrowsecurity,c.relforcerowsecurity,
    has_table_privilege(current_user,'evaluation_requests','UPDATE') AS can_update,
    has_table_privilege(current_user,'evaluation_requests','DELETE') AS can_delete,
    has_table_privilege(current_user,'evaluation_requests','TRUNCATE') AS can_truncate,
    has_table_privilege(current_user,'evaluation_request_completions','INSERT') AS can_complete,
    r.rolsuper,r.rolbypassrls FROM pg_class c,pg_roles r WHERE c.oid='evaluation_requests'::regclass AND r.rolname=current_user`)
      ).rows[0],
  );
  expect(flags).toEqual({
    relrowsecurity: true,
    relforcerowsecurity: true,
    can_update: false,
    can_delete: false,
    can_truncate: false,
    can_complete: false,
    rolsuper: false,
    rolbypassrls: false,
  });
  for (const sql of ['UPDATE evaluation_requests SET fingerprint=fingerprint WHERE id=$1', 'DELETE FROM evaluation_requests WHERE id=$1']) {
    await expect(database.withTenant(x.principal.tenantId, (client) => client.query(sql, [request.id]), { actor: x.principal.sub })).rejects.toMatchObject({ code: '42501' });
  }
  await expect(database.withTenant(x.principal.tenantId, (client) => client.query('TRUNCATE evaluation_requests'), { actor: x.principal.sub })).rejects.toMatchObject({
    code: '42501',
  });
  await expect(
    database.withTenant(
      x.principal.tenantId,
      (client) =>
        client.query('INSERT INTO evaluation_request_completions (request_id,tenant_id,evaluation_id) VALUES ($1,$2,$3)', [request.id, x.principal.tenantId, randomUUID()]),
      { actor: x.principal.sub },
    ),
  ).rejects.toMatchObject({ code: '42501' });
  const foreign = await eligible();
  expect(
    await database.withTenant(foreign.principal.tenantId, async (client) => (await client.query('SELECT id FROM evaluation_requests WHERE id=$1', [request.id])).rows),
  ).toEqual([]);
  await withAdmin(pg.workerUrl, async (client) => {
    const permissions = (
      await client.query(`SELECT has_table_privilege(current_user,'evaluation_requests','SELECT') AS requests,
      has_table_privilege(current_user,'evaluation_request_completions','INSERT') AS complete,
      has_function_privilege(current_user,'evaluation_request_lock()','EXECUTE') AS lock`)
    ).rows[0];
    expect(permissions).toEqual({ requests: false, complete: false, lock: false });
    await expect(client.query('SELECT * FROM evaluation_requests')).rejects.toMatchObject({ code: '42501' });
  });
  expect(PRODUCTION_JOBS.map((job) => job.type)).toEqual(['uploads.sweep', 'files.verify-stored', 'files.verify-stale']);
  expect(evaluationRequest.payload.safeParse({ requestId: request.id, provider: 'bedrock' }).success).toBe(false);
  expect(await counts(x.principal.tenantId)).toEqual({ requests: 1, jobs: 1 });
});

it('refuses status when a queue idempotency binding has drifted', async () => {
  const x = await eligible();
  const { request } = await service().admit(x.principal, x.input);
  await withAdmin(pg.adminUrl, async (client) => {
    await client.query("UPDATE jobs SET idempotency_key='synthetic-wrong-binding' WHERE id=$1", [request.jobId]);
  });
  await expect(service().get(x.principal, request.id)).rejects.toMatchObject({ status: 503 });
});

it('preserves the existing ledger-compromised refusal while another organization can still admit', async () => {
  const x = await eligible();
  const other = await eligible();
  await withAdmin(pg.adminUrl, async (client) => {
    await client.query(`INSERT INTO ledger_incidents (scope,tenant_id,kind,source,recorded_by) VALUES ('tenant',$1,'synthetic-record-mismatch','manual','syn-operator')`, [
      x.principal.tenantId,
    ]);
  });
  await expect(service().admit(x.principal, x.input)).rejects.toMatchObject({ status: 503, code: ErrorCode.LEDGER_COMPROMISED });
  expect(await counts(x.principal.tenantId)).toEqual({ requests: 0, jobs: 0 });
  expect((await service().admit(other.principal, other.input)).created).toBe(true);
});

it.each(['captureId', 'acceptanceId', 'reportId'] as const)('refuses an unknown %s without reserving a retry identity or leaving a job', async (field) => {
  const x = await eligible();
  await expect(service().admit(x.principal, { ...x.input, [field]: randomUUID() })).rejects.toMatchObject({ status: 409 });
  expect(await counts(x.principal.tenantId)).toEqual({ requests: 0, jobs: 0 });
  expect((await service().admit(x.principal, x.input)).created).toBe(true);
});

it('refuses an unverified file/patient link and an already-suspended organization', async () => {
  const x = await eligible();
  const report = await seedLabReport(pg.adminUrl, x.principal.tenantId);
  const capture = captureFor(report);
  const stored = await x.ledger.insertCapture(x.principal.tenantId, report.uploader, capture);
  const accepted = await x.ledger.insertAcceptance(x.principal.tenantId, 'syn-reviewer', acceptanceFor(stored.record.id, capture));
  await expect(service().admit(x.principal, { ...x.input, reportId: report.reportId, captureId: stored.record.id, acceptanceId: accepted.record.id })).rejects.toMatchObject({
    status: 409,
  });
  expect(await counts(x.principal.tenantId)).toEqual({ requests: 0, jobs: 0 });
  await withAdmin(pg.adminUrl, async (client) => {
    await client.query("UPDATE tenants SET status='suspended',changed_by='syn-test' WHERE id=$1", [x.principal.tenantId]);
  });
  await expect(service().admit(x.principal, x.input)).rejects.toMatchObject({ status: 403 });
});

it.each(['reportSha256', 'objectVersion', 'textSha256'] as const)('rejects a substituted %s at the direct SQL boundary and rolls back its queued job', async (field) => {
  const x = await eligible();
  await expect(
    database.withTenant(
      x.principal.tenantId,
      async (client) => {
        const original = (await client.query('SELECT evaluation_request_basis($1,$2,$3) AS basis', [x.input.reportId, x.input.captureId, x.input.acceptanceId])).rows[0].basis;
        const basis = { ...original, [field]: field === 'objectVersion' ? 'synthetic-substitution' : sha('substitution') };
        const id = randomUUID();
        const job = await enqueueJob(client, evaluationRequest, { requestId: id }, { idempotencyKey: `evaluation-request:${id}` });
        await client.query(
          `INSERT INTO evaluation_requests (id,tenant_id,requested_by,creation_request_id,report_id,capture_id,acceptance_id,basis,execution_profile,job_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10)`,
          [
            id,
            x.principal.tenantId,
            x.principal.sub,
            x.input.requestId,
            x.input.reportId,
            x.input.captureId,
            x.input.acceptanceId,
            JSON.stringify(basis),
            JSON.stringify(profile),
            job.jobId,
          ],
        );
      },
      { actor: x.principal.sub },
    ),
  ).rejects.toMatchObject({ code: 'ER001' });
  expect(await counts(x.principal.tenantId)).toEqual({ requests: 0, jobs: 0 });
});

it('copies/freezes the trusted profile and excludes caller-selected model/provider settings', async () => {
  const x = await eligible();
  const mutable = { ...profile };
  const pinned = new EvaluationRequestsService(new EvaluationRequestsRepository(database), mutable);
  mutable.executionManifestSha256 = sha('unexpected-new-manifest');
  const admitted = await pinned.admit(x.principal, x.input);
  expect((await service().admit(x.principal, x.input)).request.id).toBe(admitted.request.id);
  expect(evaluationRequestCreateSchema.safeParse({ ...x.input, provider: 'bedrock' }).success).toBe(false);
  expect(evaluationRequestCreateSchema.safeParse({ ...x.input, tenantId: 'synthetic-client-override' }).success).toBe(false);
  for (const invalid of [
    { ...profile, version: 'latest' },
    { ...profile, executionManifestSha256: undefined },
    { ...profile, provider: 'self-hosted' },
  ]) {
    expect(evaluationExecutionProfileSchema.safeParse(invalid).success).toBe(false);
  }
});

it('refuses rollback of admitted durable work and leaves its row/job readable', async () => {
  const x = await eligible();
  const admitted = await service().admit(x.principal, x.input);
  await expect(withAdmin(pg.adminUrl, (client) => migrateDown(client))).rejects.toThrow('Durable evaluation work must be preserved');
  expect(await service().get(x.principal, admitted.request.id)).toEqual(admitted.request);
  expect(await counts(x.principal.tenantId)).toEqual({ requests: 1, jobs: 1 });
});

it('round-trips an empty migration and refuses to orphan an existing evaluation queue job', async () => {
  const isolated = await createEphemeralDatabase();
  const connection = new Database({ url: isolated.appUrl, ssl: 'disable' });
  try {
    expect(await withAdmin(isolated.adminUrl, (client) => migrateDown(client))).toEqual(['0050']);
    expect(await withAdmin(isolated.adminUrl, async (client) => (await client.query("SELECT to_regclass('public.evaluation_requests') AS requests")).rows[0].requests)).toBeNull();
    expect(await withAdmin(isolated.adminUrl, (client) => migrateUp(client))).toEqual(['0050']);
    const report = await seedLabReport(isolated.adminUrl, `syn-${randomUUID()}`);
    await connection.withTenant(
      report.tenantId,
      (client) => enqueueJob(client, evaluationRequest, { requestId: randomUUID() }, { idempotencyKey: `evaluation-request:${randomUUID()}` }),
      { actor: report.uploader },
    );
    await expect(withAdmin(isolated.adminUrl, (client) => migrateDown(client))).rejects.toThrow('Durable evaluation work must be preserved');
  } finally {
    await connection.onModuleDestroy();
    await isolated.drop();
  }
});

it('migrates durable request and receipt storage alongside the existing queue', async () => {
  const stored = await database.withTenant('syn-h1-catalog', async (client) => {
    return (
      await client.query(`SELECT to_regclass('public.jobs') IS NOT NULL AS queue,
      to_regclass('public.evaluation_requests') IS NOT NULL AS requests,
      to_regclass('public.evaluation_request_completions') IS NOT NULL AS receipts`)
    ).rows[0];
  });
  expect(stored.queue).toBe(true); // positive control: the existing schema actually migrated
  expect([stored.requests, stored.receipts]).toEqual([true, true]);
});
