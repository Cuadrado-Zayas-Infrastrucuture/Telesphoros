import { randomBytes, randomUUID } from 'node:crypto';
import { Database } from '../../src/db/database';
import { PostgresLedgerRecordsRepository } from '../../src/storage/postgres/ledger-records.repository';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';
import { acceptanceFor, captureFor, evaluationFor, seedLabReport, sha } from '../helpers/ledger-fixtures';

/** Migration 0046: size caps on the evaluation JSON, upload policies named to roles, row-level security on security_events (assessment items 7, 11, 12). */
let pg: EphemeralDatabase;
let database: Database;
let repo: PostgresLedgerRecordsRepository;

beforeAll(async () => {
  pg = await createEphemeralDatabase();
  database = new Database({ url: pg.appUrl, ssl: 'disable' });
  repo = new PostgresLedgerRecordsRepository(database);
});
afterAll(async () => {
  await database.onModuleDestroy();
  await pg.drop();
});

const catalog = <T>(sql: string, params: unknown[] = []) => withAdmin(pg.adminUrl, async (c) => (await c.query(sql, params)).rows as T[]);

async function evaluate(over: Parameters<typeof evaluationFor>[3]) {
  const t = `tenant-${randomUUID()}`;
  const seeded = await seedLabReport(pg.adminUrl, t);
  const capture = captureFor(seeded);
  const c = await repo.insertCapture(t, seeded.uploader, capture);
  const a = await repo.insertAcceptance(t, 'syn-reviewer', acceptanceFor(c.record.id, capture));
  return repo.insertEvaluation(t, 'syn-system', evaluationFor(seeded, c.record.id, a.record.id, { knowledgeSetId: sha(randomUUID()), ...over }));
}

describe('size caps on the evaluation JSON (item 7)', () => {
  it('accepts an ordinary evaluation (positive control)', async () => {
    await expect(evaluate({})).resolves.toBeDefined();
  });

  it('refuses occurrences over 1 MiB, even when the text would compress', async () => {
    const refusedBy = (over: Parameters<typeof evaluate>[0]) =>
      evaluate(over).then(
        () => 'accepted',
        (e: { constraint?: string }) => e.constraint,
      );
    expect(await refusedBy({ occurrences: [{ gene: 'CYP2C19', pad: 'a'.repeat(1_100_000) }] })).toBe('evaluations_occurrences_size');
    expect(await refusedBy({ occurrences: [{ gene: 'CYP2C19', pad: randomBytes(600_000).toString('hex') }] })).toBe('evaluations_occurrences_size');
  });

  it('has every cap validated, so existing rows were checked too', async () => {
    const rows = await catalog<{ conname: string; convalidated: boolean }>(
      `SELECT conname, convalidated FROM pg_constraint WHERE conname ~ '_size$' AND connamespace = 'public'::regnamespace`,
    );
    expect(rows.map((r) => r.conname).sort()).toEqual([
      'evaluation_results_citation_size',
      'evaluation_results_gene_evidence_size',
      'evaluations_binding_size',
      'evaluations_gene_inputs_size',
      'evaluations_occurrences_size',
    ]);
    expect(rows.every((r) => r.convalidated)).toBe(true);
  });
});

describe('policies name their roles (item 11)', () => {
  it('no policy in the schema is TO PUBLIC, and the upload policies still hold the tenant predicate', async () => {
    const rows = await catalog<{ tablename: string; policyname: string; roles: string[]; qual: string }>(
      `SELECT tablename, policyname, roles::text[] AS roles, qual FROM pg_policies WHERE schemaname = 'public'`,
    );
    expect(rows.filter((r) => r.roles.includes('public')).map((r) => r.policyname)).toEqual([]);
    for (const name of ['upload_run_tenant', 'upload_attempt_tenant']) {
      const p = rows.find((r) => r.policyname === name)!;
      expect(p.roles.sort()).toEqual(['telesphoros_app', 'telesphoros_jobs']);
      expect(p.qual).toContain('app_tenant()');
    }
  });

  it('a role outside the list sees no upload rows even with a grant (control: the application role is still bound by tenant)', async () => {
    const t = `tenant-${randomUUID()}`;
    await seedLabReport(pg.adminUrl, t);
    await withAdmin(pg.adminUrl, async (c) => {
      await c.query('BEGIN');
      try {
        await c.query('CREATE ROLE zz_hardening_probe NOLOGIN');
        await c.query('GRANT SELECT ON report_upload_runs TO zz_hardening_probe');
        await c.query('SET LOCAL ROLE zz_hardening_probe');
        await c.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [t]);
        expect((await c.query('SELECT count(*)::int AS n FROM report_upload_runs')).rows[0].n).toBe(0);
      } finally {
        await c.query('ROLLBACK');
      }
    });
  });
});

describe('security_events row-level security (item 12)', () => {
  it('is enabled with an auditor policy, and the auditor still reads while the application role still has no privilege', async () => {
    const [flags] = await catalog<{ relrowsecurity: boolean }>(`SELECT relrowsecurity FROM pg_class WHERE relname = 'security_events'`);
    expect(flags!.relrowsecurity).toBe(true);
    const policies = await catalog<{ policyname: string; roles: string[]; cmd: string }>(
      `SELECT policyname, roles::text[] AS roles, cmd FROM pg_policies WHERE tablename = 'security_events'`,
    );
    expect(policies).toEqual([{ policyname: 'security_events_auditor', roles: ['telesphoros_security_auditor'], cmd: 'SELECT' }]);
    await withAdmin(pg.auditorUrl, async (c) => expect((await c.query('SELECT count(*)::int AS n FROM security_events')).rows[0].n).toBeGreaterThanOrEqual(0));
    await withAdmin(pg.appUrl, async (c) => expect(c.query('SELECT 1 FROM security_events')).rejects.toThrow(/permission denied/));
  });

  it('still takes events from the definer function (the writer path is not blocked by the policy)', async () => {
    const t = `tenant-${randomUUID()}`;
    await withAdmin(pg.adminUrl, async (c) => {
      await c.query(`INSERT INTO tenants (id, display_name, created_by, changed_by) VALUES ($1, 'syn', 'syn-op', 'syn-op')`, [t]);
      await c.query(`INSERT INTO tenant_memberships (tenant_id, sub, status, roles, changed_by) VALUES ($1, 'syn-person', 'active', '{clinician}', 'syn-op')`, [t]);
    });
    const n = await catalog<{ n: number }>(`SELECT count(*)::int AS n FROM security_events WHERE tenant_id = $1`, [t]);
    expect(n[0]!.n).toBeGreaterThan(0); // the membership trigger wrote its event as the owner
  });
});
