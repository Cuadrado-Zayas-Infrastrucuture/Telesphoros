import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { enqueueJob, evaluationRequest } from '@telesphoros/jobs';
import { Database } from '../../src/db/database';
import { EvaluationRequestsService } from '../../src/lab-reports/evaluation-requests.service';
import { EvaluationRequestsRepository } from '../../src/storage/postgres/evaluation-requests.repository';
import { PostgresLedgerRecordsRepository } from '../../src/storage/postgres/ledger-records.repository';
import { migrateDown, migrateUp } from '../../src/db/migrator';
import { provisionLogins, type SecretStore } from '../../src/db/provision-logins';
import { pgClientConfig } from '../../src/db/tls';
import { adminUrl, withAdmin } from '../helpers/database';
import { acceptanceFor, captureFor, evaluationFor, seedLabReport } from '../helpers/ledger-fixtures';
import { revertAbove, revertThrough } from '../helpers/migration-history';

/**
 * The "refuse to drop populated data" guards in the down migrations, run as the login an operator really uses: `telesphoros_migrator`, which owns
 * the tables, is NOT a superuser and does NOT bypass row-level security. A table with FORCE ROW LEVEL SECURITY and policies for other roles only shows
 * that login no rows, so a guard that just asks `EXISTS (SELECT 1 FROM that_table)` answers "empty" and the down drops the data without the refusal.
 * Every other down test runs as the cluster superuser, which sees every row; that is why this was never noticed.
 */
jest.setTimeout(240_000);

class MemoryStore implements SecretStore {
  values = new Map<string, string>();
  async get(id: string) {
    return this.values.get(id);
  }
  async put(id: string, value: string) {
    this.values.set(id, value);
  }
}

interface Fixture {
  admin: string;
  /** The application login's URL (what the API connects with). */
  app: string;
  migrator: Client;
  drop: () => Promise<void>;
}

const tenant = 'syn-down-guard';
const hash = 'a'.repeat(64);

async function fixture(): Promise<Fixture> {
  const tag = randomBytes(4).toString('hex');
  const database = `test_dg_${tag}`;
  const names = { app: `dg_app_${tag}`, verifier: `dg_ver_${tag}`, migrator: `dg_mig_${tag}`, worker: `dg_wrk_${tag}`, issuer: `dg_iss_${tag}` };
  await withAdmin(adminUrl(), (c) => c.query(`CREATE DATABASE ${database}`));
  const base = new URL(adminUrl());
  const admin = new URL(base);
  admin.pathname = `/${database}`;
  const store = new MemoryStore();
  let migrator: Client | undefined;
  const drop = async () => {
    await migrator?.end().catch(() => undefined);
    await withAdmin(adminUrl(), async (c) => {
      await c.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      for (const name of Object.values(names)) await c.query(`DROP ROLE IF EXISTS ${name}`);
    });
  };
  try {
    await provisionLogins({
      adminUrl: admin.toString(),
      tls: 'disable',
      target: { host: base.hostname, port: Number(base.port) },
      secrets: { app: 'a', verifier: 'v', migrator: 'm', worker: 'w' },
      store,
      names,
    });
    migrator = new Client(pgClientConfig(store.values.get('m')!, 'disable'));
    await migrator.connect();
    await migrateUp(migrator);
    return { admin: admin.toString(), app: store.values.get('a')!, migrator, drop };
  } catch (error) {
    await drop();
    throw error;
  }
}

const patient = async (c: Client, withRequest = false) =>
  (
    await c.query(`INSERT INTO patients (tenant_id, created_by, label, creation_request_id, creation_request_hash) VALUES ($1, 'syn-author', $2, $3, $4) RETURNING id`, [
      tenant,
      `SYN-${randomUUID()}`,
      withRequest ? randomUUID() : null,
      withRequest ? hash : null,
    ])
  ).rows[0].id as string;

const report = async (c: Client, patientId: string, columns = '', values: unknown[] = []) =>
  (
    await c.query(
      `INSERT INTO reports (tenant_id, created_by, patient_id, type, original_filename, size_bytes${columns}) VALUES ($1, 'syn-author', $2, 'structured', 'p.json', 1${values.map((_, i) => `, $${i + 3}`).join('')}) RETURNING id`,
      [tenant, patientId, ...values],
    )
  ).rows[0].id as string;

interface GuardCase {
  anchor: string;
  /** The session setting that allows the drop on purpose. */
  allow: string;
  refusal: RegExp;
  populate: (c: Client, f: Fixture) => Promise<void>;
}

const cases: GuardCase[] = [
  {
    anchor: 'agentic_explain_runs',
    allow: 'telesphoros.allow_runs_drop',
    refusal: /Refusing to drop agentic_explain_runs/,
    populate: async (c) => {
      await c.query(
        `INSERT INTO public.agentic_explain_runs (tenant_id, requester_ref, key_hash, tuple_digest, harness_version, state, mono_at, deadline_at)
         VALUES ($1, 'syn-author', $2, $3, $2, 'admitted', 1, clock_timestamp() + interval '1 minute')`,
        [tenant, `sha256:${hash}`, `hmac-sha256:${hash}`],
      );
    },
  },
  {
    anchor: 'agentic_explain_receipts',
    allow: 'telesphoros.allow_receipts_drop',
    refusal: /Refusing to drop agentic_explain_receipts/,
    populate: async (c) => {
      await c.query(
        `INSERT INTO public.agentic_explain_receipts (tenant_id, run_id, requester_ref, task, terminal_state, reason_code, harness_version, evidence_digest, slots, model_calls, input_units, generated_units, usage_state)
         VALUES ($1, 'run-down-guard', 'syn-author', 'pgx.explain.v1', 'held', 'NOT_ELIGIBLE', $2, $3, 0, 0, 0, 0, 'known')`,
        [tenant, `sha256:${hash}`, `hmac-sha256:${hash}`],
      );
    },
  },
  {
    anchor: 'report_evidence',
    allow: 'telesphoros.allow_audit_drop',
    refusal: /Refusing to drop report evidence columns that hold data/,
    populate: async (c) => {
      await report(c, await patient(c), ', upload_requested_by', ['syn-author']);
    },
  },
  {
    anchor: 'report_creation_requests',
    allow: 'telesphoros.allow_report_retry_drop',
    refusal: /Refusing to drop populated/,
    populate: async (c) => {
      await report(c, await patient(c), ', creation_request_id, creation_request_hash', [randomUUID(), hash]);
    },
  },
  {
    anchor: 'upload_attempts',
    allow: 'telesphoros.allow_upload_attempt_drop',
    refusal: /Refusing to drop populated upload attempts/,
    populate: async (c) => {
      const patientId = await patient(c);
      const reportId = await report(c, patientId);
      const run = randomUUID();
      await c.query('INSERT INTO report_upload_runs (run_id, tenant_id) VALUES ($1, $2)', [run, tenant]);
      await c.query(
        `INSERT INTO report_upload_attempts (request_id, run_id, tenant_id, report_id, patient_id, principal, revision, declaration_revision, type, size_bytes, content_type, sha256, storage_key, state, lease_until)
         VALUES ($1, $2, $3, $4, $5, 'syn-author', $6, $7, 'structured', 1, 'application/json', $8, $9, 'declared', now() + interval '1 hour')`,
        [randomUUID(), run, tenant, reportId, patientId, randomUUID(), randomUUID(), 'b'.repeat(64), `k/${randomUUID()}`],
      );
    },
  },
  {
    anchor: 'patient_creation_requests',
    allow: 'telesphoros.allow_patient_retry_drop',
    refusal: /Refusing to drop populated patient creation retry identities/,
    populate: async (c) => {
      await patient(c, true);
    },
  },
  {
    anchor: 'identifier_creation_requests',
    allow: 'telesphoros.allow_identifier_retry_drop',
    refusal: /Refusing to drop populated identifier creation retry identities/,
    populate: async (c) => {
      await c.query(
        `INSERT INTO patient_identifiers (tenant_id, patient_id, system, value_digest, created_by, creation_request_id, creation_request_hash)
         VALUES ($1, $2, 'mrn', decode($3, 'hex'), 'syn-author', $4, $5)`,
        [tenant, await patient(c), 'c'.repeat(64), randomUUID(), hash],
      );
    },
  },
  {
    anchor: 'capture_decision_requests',
    allow: 'telesphoros.allow_capture_decision_retry_drop',
    refusal: /Refusing to drop populated capture decision retry identities/,
    // A ledger record: written the way the API writes it, through the application login.
    populate: async (_c, f) => {
      const database = new Database({ url: f.app, ssl: 'disable' });
      try {
        const repo = new PostgresLedgerRecordsRepository(database);
        const report = await seedLabReport(f.admin, tenant);
        const capture = captureFor(report);
        const stored = await repo.insertCapture(tenant, report.uploader, capture);
        const hash = createHash('sha256').update('request').digest('hex');
        await repo.insertAcceptance(tenant, 'syn-reviewer', acceptanceFor(stored.record.id, capture, { request: { id: randomUUID(), hash } }));
      } finally {
        await database.onModuleDestroy();
      }
    },
  },
  {
    anchor: 'dispute_creation_requests',
    allow: 'telesphoros.allow_dispute_retry_drop',
    refusal: /Refusing to drop populated dispute creation retry identities/,
    // A ledger record: written the way the API writes it, through the application login.
    populate: async (_c, f) => {
      const database = new Database({ url: f.app, ssl: 'disable' });
      try {
        await new PostgresLedgerRecordsRepository(database).raiseDispute(tenant, 'syn-reviewer', {
          guidelineId: 'syn-guideline',
          guidelineVersion: '1',
          guidelineContentSha256: 'c'.repeat(64),
          locator: { table: 'recommendations', row: 'r1' },
          note: 'reads wrongly',
          request: { id: randomUUID(), hash: createHash('sha256').update('dispute').digest('hex') },
        });
      } finally {
        await database.onModuleDestroy();
      }
    },
  },
];

/** Whether each of these tables that still exists is FORCE ROW LEVEL SECURITY (a table a rollback has removed is not asked about). */
const stillForced = async (c: Client) =>
  (
    await c.query<{ relname: string; f: boolean }>(
      `SELECT relname, relforcerowsecurity AS f FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname IN ('reports', 'patients', 'patient_identifiers', 'capture_acceptances', 'cell_disputes') ORDER BY 1`,
    )
  ).rows;

const setting = (c: Client, name: string, value: string) => c.query('SELECT set_config($1, $2, false)', [name, value]);
const AUDIT = 'telesphoros.allow_audit_drop';

/**
 * The audit migrations (0005 to 0009, 0020, 0021) refuse unconditionally unless `allow_audit_drop` is set, and 0010's own guard uses the same setting.
 * So everything ABOVE the migration under test is reverted first with that setting on, then it is switched off and the migration under test is reverted alone.
 */
async function revertAboveThenSwitchOff(c: Client, anchor: string): Promise<void> {
  const above = revertAbove(anchor);
  await setting(c, AUDIT, 'yes');
  expect(await migrateDown(c, above.steps)).toEqual(above.reverted);
  await setting(c, AUDIT, '');
}

describe('down-migration guards, run as the migrator login (owner of the tables, no BYPASSRLS)', () => {
  it('round-trips empty H1 storage as the restricted migration login', async () => {
    const f = await fixture();
    try {
      expect((await f.migrator.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
      const through = revertThrough('evaluation_requests');
      expect(await migrateDown(f.migrator, through.steps)).toEqual(through.reverted);
      expect(await migrateUp(f.migrator)).toEqual([...through.reverted].reverse());
      expect((await stillForced(f.migrator)).every((t) => t.f)).toBe(true);
    } finally {
      await f.drop();
    }
  });

  it.each(['request', 'orphan job'] as const)('refuses H1 %s data as the restricted migrator and restores forced RLS', async (kind) => {
    const f = await fixture();
    const connection = new Database({ url: f.app, ssl: 'disable' });
    try {
      const report = await seedLabReport(f.admin, tenant);
      const actor = 'syn-h1-clinician';
      const ledger = new PostgresLedgerRecordsRepository(connection);
      await withAdmin(f.admin, (c) =>
        c.query(`INSERT INTO tenant_memberships (tenant_id,sub,status,roles,changed_by) VALUES ($1,$2,'active',ARRAY['clinician'],'syn-test')`, [tenant, actor]),
      );
      if (kind === 'request') {
        const capture = captureFor(report);
        const stored = await ledger.insertCapture(tenant, report.uploader, capture);
        const acceptance = await ledger.insertAcceptance(tenant, 'syn-reviewer', acceptanceFor(stored.record.id, capture));
        await ledger.insertPatientDecision(tenant, 'syn-verifier', {
          reportId: report.reportId,
          expectedReport: { patientId: report.patientId, sha256: report.pdfSha256, objectVersion: report.objectVersion },
          decision: 'verified',
          method: 'person-confirmed',
          basisCode: 'no-identifier-on-report',
        });
        const service = new EvaluationRequestsService(new EvaluationRequestsRepository(connection), {
          version: 'evaluation-execution-profile/1',
          codeArtifactSha256: hash,
          executionManifestSha256: hash,
          knowledgeSetId: hash,
          recordingsSha256: hash,
        });
        const principal = { tenantId: tenant, sub: actor, roles: ['clinician' as const] };
        const token = randomBytes(32).toString('hex');
        await withAdmin(f.admin, async (c) => {
          const issued = (await c.query("SELECT * FROM tenant_capability_issue_current($1,$2,'request',$3,NULL)", [tenant, actor, createHash('sha256').update(token).digest()]))
            .rows[0];
          expect(issued.refusal).toBeNull();
        });
        // Exercise the existing membership lock's capability-present dependencies
        // under its actual non-superuser definer, not an admin-owned test schema.
        await connection.withTenant(
          tenant,
          async (c) => {
            await c.query("SELECT set_config('app.capability',$1,true)", [token]);
            const basis = (await c.query('SELECT evaluation_request_basis($1,$2,$3) AS basis', [report.reportId, stored.record.id, acceptance.record.id])).rows[0].basis;
            expect(basis.patientId).toBe(report.patientId);
          },
          { actor },
        );
        const admitted = await service.admit(principal, { reportId: report.reportId, captureId: stored.record.id, acceptanceId: acceptance.record.id, requestId: randomUUID() });
        const above = revertAbove('evaluation_requests');
        expect(await migrateDown(f.migrator, above.steps)).toEqual(above.reverted); // H3 holds no completion yet, so it reverts with the newer ones; then 0050's own guard is under test
        await expect(migrateDown(f.migrator, 1)).rejects.toThrow('Durable evaluation work must be preserved');
        expect(await service.get(principal, admitted.request.id)).toEqual(admitted.request);
      } else {
        await connection.withTenant(tenant, (c) => enqueueJob(c, evaluationRequest, { requestId: randomUUID() }, { idempotencyKey: `evaluation-request:${randomUUID()}` }), {
          actor,
        });
        const above = revertAbove('evaluation_requests');
        expect(await migrateDown(f.migrator, above.steps)).toEqual(above.reverted);
        await expect(migrateDown(f.migrator, 1)).rejects.toThrow('Durable evaluation work must be preserved');
      }
      expect((await f.migrator.query("SELECT version FROM schema_migrations WHERE version='0050'")).rowCount).toBe(1);
      const forced = (
        await f.migrator.query("SELECT relforcerowsecurity AS forced FROM pg_class WHERE oid IN ('evaluation_requests'::regclass,'evaluation_request_completions'::regclass)")
      ).rows;
      expect(forced).toEqual([{ forced: true }, { forced: true }]);
      await withAdmin(f.admin, async (c) => {
        expect((await c.query("SELECT count(*)::int AS n FROM jobs WHERE tenant_id=$1 AND type='evaluations.request'", [tenant])).rows[0].n).toBe(1);
      });
    } finally {
      await connection.onModuleDestroy();
      await f.drop();
    }
  });

  it('refuses to revert H3 while a completion exists, as the restricted migrator, and restores forced RLS', async () => {
    const f = await fixture();
    const connection = new Database({ url: f.app, ssl: 'disable' });
    try {
      const report = await seedLabReport(f.admin, tenant);
      const actor = 'syn-h3-clinician';
      const ledger = new PostgresLedgerRecordsRepository(connection);
      await withAdmin(f.admin, (c) =>
        c.query(`INSERT INTO tenant_memberships (tenant_id,sub,status,roles,changed_by) VALUES ($1,$2,'active',ARRAY['clinician'],'syn-test')`, [tenant, actor]),
      );
      const capture = captureFor(report);
      const stored = await ledger.insertCapture(tenant, report.uploader, capture);
      const acceptance = await ledger.insertAcceptance(tenant, 'syn-reviewer', acceptanceFor(stored.record.id, capture));
      const linked = await ledger.insertPatientDecision(tenant, 'syn-verifier', {
        reportId: report.reportId,
        expectedReport: { patientId: report.patientId, sha256: report.pdfSha256, objectVersion: report.objectVersion },
        decision: 'verified',
        method: 'person-confirmed',
        basisCode: 'no-identifier-on-report',
      });
      const evaluation = await ledger.insertEvaluation(tenant, actor, evaluationFor(report, stored.record.id, acceptance.record.id, { patientLinkDecisionId: linked.record.id }));
      const service = new EvaluationRequestsService(new EvaluationRequestsRepository(connection), {
        version: 'evaluation-execution-profile/1',
        codeArtifactSha256: hash,
        executionManifestSha256: hash,
        knowledgeSetId: hash,
        recordingsSha256: hash,
      });
      const { request } = await service.admit(
        { tenantId: tenant, sub: actor, roles: ['clinician'] },
        { reportId: report.reportId, captureId: stored.record.id, acceptanceId: acceptance.record.id, requestId: randomUUID() },
      );
      // Written past the table's own check, as only the owner could: what is under test is the down migration's refusal, not how the row got there.
      await withAdmin(f.admin, async (c) => {
        await c.query('BEGIN');
        await c.query('SET LOCAL session_replication_role = replica');
        await c.query('INSERT INTO evaluation_request_completions (request_id,tenant_id,evaluation_id,job_id,worker_id) VALUES ($1,$2,$3,$4,$5)', [
          request.id,
          tenant,
          evaluation.record.id,
          request.jobId,
          'syn-worker',
        ]);
        await c.query('COMMIT');
      });
      expect((await f.migrator.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });

      const above = revertAbove('evaluation_request_completion');
      expect(await migrateDown(f.migrator, above.steps)).toEqual(above.reverted);
      await expect(migrateDown(f.migrator, 1)).rejects.toThrow('Durable evaluation work must be preserved');

      expect((await f.migrator.query("SELECT version FROM schema_migrations WHERE version='0051'")).rowCount).toBe(1);
      expect((await f.migrator.query("SELECT relforcerowsecurity AS forced FROM pg_class WHERE oid='evaluation_request_completions'::regclass")).rows).toEqual([{ forced: true }]);
      await withAdmin(f.admin, async (c) => {
        expect((await c.query('SELECT count(*)::int AS n FROM evaluation_request_completions WHERE tenant_id=$1', [tenant])).rows[0].n).toBe(1);
      });
    } finally {
      await connection.onModuleDestroy();
      await f.drop();
    }
  });

  it('refuses to revert H4 cancellations while one exists, as the restricted migrator, and restores forced RLS', async () => {
    const f = await fixture();
    const connection = new Database({ url: f.app, ssl: 'disable' });
    try {
      const report = await seedLabReport(f.admin, tenant);
      const actor = 'syn-h4-clinician';
      const ledger = new PostgresLedgerRecordsRepository(connection);
      await withAdmin(f.admin, (c) =>
        c.query(`INSERT INTO tenant_memberships (tenant_id,sub,status,roles,changed_by) VALUES ($1,$2,'active',ARRAY['clinician'],'syn-test')`, [tenant, actor]),
      );
      const capture = captureFor(report);
      const stored = await ledger.insertCapture(tenant, report.uploader, capture);
      const acceptance = await ledger.insertAcceptance(tenant, 'syn-reviewer', acceptanceFor(stored.record.id, capture));
      await ledger.insertPatientDecision(tenant, 'syn-verifier', {
        reportId: report.reportId,
        expectedReport: { patientId: report.patientId, sha256: report.pdfSha256, objectVersion: report.objectVersion },
        decision: 'verified',
        method: 'person-confirmed',
        basisCode: 'no-identifier-on-report',
      });
      const service = new EvaluationRequestsService(new EvaluationRequestsRepository(connection), {
        version: 'evaluation-execution-profile/1',
        codeArtifactSha256: hash,
        executionManifestSha256: hash,
        knowledgeSetId: hash,
        recordingsSha256: hash,
      });
      const principal = { tenantId: tenant, sub: actor, roles: ['clinician' as const] };
      const { request } = await service.admit(principal, { reportId: report.reportId, captureId: stored.record.id, acceptanceId: acceptance.record.id, requestId: randomUUID() });
      await service.cancel(principal, request.id);
      expect((await f.migrator.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });

      const above = revertAbove('evaluation_request_cancellations');
      expect(await migrateDown(f.migrator, above.steps)).toEqual(above.reverted);
      await expect(migrateDown(f.migrator, 1)).rejects.toThrow('Durable evaluation work must be preserved');

      expect((await f.migrator.query("SELECT version FROM schema_migrations WHERE version='0054'")).rowCount).toBe(1);
      expect((await f.migrator.query("SELECT relforcerowsecurity AS forced FROM pg_class WHERE oid='evaluation_request_cancellations'::regclass")).rows).toEqual([
        { forced: true },
      ]);
      await withAdmin(f.admin, async (c) => {
        expect((await c.query('SELECT count(*)::int AS n FROM evaluation_request_cancellations WHERE tenant_id=$1', [tenant])).rows[0].n).toBe(1);
      });
    } finally {
      await connection.onModuleDestroy();
      await f.drop();
    }
  });

  it.each(cases)('$anchor: a populated table is refused, the refusal rolls back whole, and the setting that allows it still works', async (guard) => {
    const f = await fixture();
    try {
      const me = (await f.migrator.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user')).rows[0];
      expect(me).toEqual({ rolsuper: false, rolbypassrls: false }); // the login under test is the restricted one
      await withAdmin(f.admin, (c) => guard.populate(c, f));
      const version = revertThrough(guard.anchor).reverted.at(-1)!;
      await revertAboveThenSwitchOff(f.migrator, guard.anchor);

      await expect(migrateDown(f.migrator, 1)).rejects.toThrow(guard.refusal);
      // The refusal left nothing half done: the version is still applied and the tables are still forced.
      expect((await f.migrator.query('SELECT 1 FROM schema_migrations WHERE version = $1', [version])).rowCount).toBe(1);
      const before = await stillForced(f.migrator);
      expect(before.length).toBeGreaterThan(0);
      expect(before.every((t) => t.f)).toBe(true);

      await setting(f.migrator, guard.allow, 'yes');
      expect(await migrateDown(f.migrator, 1)).toEqual([version]);
      expect((await stillForced(f.migrator)).every((t) => t.f)).toBe(true); // lifting FORCE for the check did not outlive the migration
    } finally {
      await f.drop();
    }
  });

  // Spec 006 D01b: no override exists (the ledger's type CHECK cannot be restored while a decision event exists), so a populated table is refused
  // outright; the empty case reverts in the test below.
  it('clinician_result_decisions: a populated table is refused as the migrator, the refusal rolls back whole, and FORCE is restored', async () => {
    const f = await fixture();
    const connection = new Database({ url: f.app, ssl: 'disable' });
    try {
      const repo = new PostgresLedgerRecordsRepository(connection);
      const report = await seedLabReport(f.admin, tenant);
      const capture = captureFor(report);
      const stored = await repo.insertCapture(tenant, report.uploader, capture);
      const acceptance = await repo.insertAcceptance(tenant, 'syn-reviewer', acceptanceFor(stored.record.id, capture));
      await repo.insertPatientDecision(tenant, 'syn-verifier', {
        reportId: report.reportId,
        expectedReport: { patientId: report.patientId, sha256: report.pdfSha256, objectVersion: report.objectVersion },
        decision: 'verified',
        method: 'person-confirmed',
        basisCode: 'no-identifier-on-report',
      });
      const evaluation = (await repo.insertEvaluation(tenant, 'syn-system', evaluationFor(report, stored.record.id, acceptance.record.id))).record;
      const actor = 'syn-cdr-clinician';
      const shown = await withAdmin(f.admin, async (c) => {
        await c.query(`INSERT INTO tenant_memberships (tenant_id,sub,status,roles,changed_by) VALUES ($1,$2,'active',ARRAY['clinician'],'syn-test')`, [tenant, actor]);
        return (await c.query<{ id: string }>(`SELECT id::text AS id FROM evaluation_results WHERE evaluation_id = $1 AND outcome = 'shown'`, [evaluation.id])).rows[0]!.id;
      });
      await repo.insertClinicianDecision(tenant, actor, {
        resultId: shown,
        evaluationId: evaluation.id as string,
        patientId: report.patientId,
        entryKind: 'decision',
        previousEntryId: null,
        response: 'accepted',
        detailCodes: [],
        reviewBy: null,
        request: { id: randomUUID(), hash },
      });
      const version = revertThrough('clinician_result_decisions').reverted.at(-1)!;
      await revertAboveThenSwitchOff(f.migrator, 'clinician_result_decisions');
      await expect(migrateDown(f.migrator, 1)).rejects.toThrow(/Refusing to drop populated clinician decisions/);
      await setting(f.migrator, AUDIT, 'yes'); // no setting allows it: the audit one does not either
      await expect(migrateDown(f.migrator, 1)).rejects.toThrow(/Refusing to drop populated clinician decisions/);
      expect((await f.migrator.query('SELECT 1 FROM schema_migrations WHERE version = $1', [version])).rowCount).toBe(1);
      expect((await f.migrator.query(`SELECT relforcerowsecurity AS f FROM pg_class WHERE oid = 'clinician_result_decisions'::regclass`)).rows).toEqual([{ f: true }]);
    } finally {
      await connection.onModuleDestroy();
      await f.drop();
    }
  });

  // Spec 019 D02a: as D01b, no override exists (the ledger's type CHECK cannot be restored while an acknowledgement event exists); the empty case
  // reverts in the last test below.
  it('result_acknowledgements: a populated table is refused as the migrator, the refusal rolls back whole, and FORCE is restored', async () => {
    const f = await fixture();
    const connection = new Database({ url: f.app, ssl: 'disable' });
    try {
      const repo = new PostgresLedgerRecordsRepository(connection);
      const report = await seedLabReport(f.admin, tenant);
      const capture = captureFor(report);
      const stored = await repo.insertCapture(tenant, report.uploader, capture);
      const acceptance = await repo.insertAcceptance(tenant, 'syn-reviewer', acceptanceFor(stored.record.id, capture));
      await repo.insertPatientDecision(tenant, 'syn-verifier', {
        reportId: report.reportId,
        expectedReport: { patientId: report.patientId, sha256: report.pdfSha256, objectVersion: report.objectVersion },
        decision: 'verified',
        method: 'person-confirmed',
        basisCode: 'no-identifier-on-report',
      });
      const evaluation = (await repo.insertEvaluation(tenant, 'syn-system', evaluationFor(report, stored.record.id, acceptance.record.id))).record;
      const actor = 'syn-ack-clinician';
      const shown = await withAdmin(f.admin, async (c) => {
        await c.query(`INSERT INTO tenant_memberships (tenant_id,sub,status,roles,changed_by) VALUES ($1,$2,'active',ARRAY['clinician'],'syn-test')`, [tenant, actor]);
        return (await c.query<{ id: string }>(`SELECT id::text AS id FROM evaluation_results WHERE evaluation_id = $1 AND outcome = 'shown'`, [evaluation.id])).rows[0]!.id;
      });
      await repo.insertResultAcknowledgement(tenant, actor, {
        resultId: shown,
        patientId: report.patientId,
        kind: 'review',
        reviewTask: 'result-review',
        displayedBasis: ['active'],
        request: { id: randomUUID(), hash },
      });
      const version = revertThrough('result_acknowledgements').reverted.at(-1)!;
      await revertAboveThenSwitchOff(f.migrator, 'result_acknowledgements');
      await expect(migrateDown(f.migrator, 1)).rejects.toThrow(/Refusing to drop populated result acknowledgements/);
      await setting(f.migrator, AUDIT, 'yes'); // no setting allows it: the audit one does not either
      await expect(migrateDown(f.migrator, 1)).rejects.toThrow(/Refusing to drop populated result acknowledgements/);
      expect((await f.migrator.query('SELECT 1 FROM schema_migrations WHERE version = $1', [version])).rowCount).toBe(1);
      expect((await f.migrator.query(`SELECT relforcerowsecurity AS f FROM pg_class WHERE oid = 'result_acknowledgements'::regclass`)).rows).toEqual([{ f: true }]);
    } finally {
      await connection.onModuleDestroy();
      await f.drop();
    }
  });

  it('refuses to revert the worker job capability (spec 012) while an issuance record of one exists, as the restricted migrator', async () => {
    const f = await fixture();
    try {
      const above = revertAbove('worker_job_capability');
      expect(await migrateDown(f.migrator, above.steps)).toEqual(above.reverted);
      await withAdmin(f.admin, (c) =>
        c.query(`INSERT INTO capability_issuance_log (occurred_at, purpose, request_id, outcome, reason) VALUES (now(), 'evaluation-job', $1, 'refused', 'job-not-held')`, [
          randomUUID(),
        ]),
      );
      await expect(migrateDown(f.migrator, 1)).rejects.toThrow('Capability issuance records must be preserved');
      const version = revertThrough('worker_job_capability').reverted.at(-1)!;
      expect((await f.migrator.query('SELECT 1 FROM schema_migrations WHERE version = $1', [version])).rowCount).toBe(1);
    } finally {
      await f.drop();
    }
  });

  it('with nothing in those tables every one of these rollbacks goes through, so a guard refuses populated data and not everything', async () => {
    const f = await fixture();
    try {
      const through = revertThrough('report_evidence');
      await setting(f.migrator, AUDIT, 'yes'); // for the unconditional audit guards above 0010
      const above = revertAbove('report_evidence');
      expect(await migrateDown(f.migrator, above.steps)).toEqual(above.reverted);
      await setting(f.migrator, AUDIT, '');
      expect(await migrateDown(f.migrator, 1)).toEqual([through.reverted.at(-1)]);
      expect((await stillForced(f.migrator)).every((t) => t.f)).toBe(true);
    } finally {
      await f.drop();
    }
  });
});
