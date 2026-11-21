import { randomUUID } from 'node:crypto';
import { Database } from '../../src/db/database';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';

// Spec 046 at the database: security_audit_review() as the application role, with the organisation and person bound as a request binds them. The
// expected rows are written by hand; audit rows are seeded through the administrator connection, as the writer would store them. Synthetic ids only.
const usingPostgres = process.env.TEST_STORAGE === 'postgres';
(usingPostgres ? describe : describe.skip)('security_audit_review() in the database', () => {
  let db: EphemeralDatabase;
  let database: Database;
  beforeAll(async () => {
    db = await createEphemeralDatabase();
    database = new Database({ url: db.appUrl, ssl: 'disable' });
  }, 60_000);
  afterAll(async () => {
    await database.onModuleDestroy();
    await db.drop();
  });

  const patient = randomUUID();
  const other = randomUUID();

  /** An organisation with an admin, a clinician and a removed admin, and audit rows of every kind. */
  async function organisation() {
    const tenant = `t-${randomUUID().slice(0, 8)}`;
    const people = { admin: `syn-adm-${tenant}`, clinician: `syn-clin-${tenant}`, removed: `syn-gone-${tenant}` };
    await withAdmin(db.adminUrl, async (c) => {
      await c.query(`INSERT INTO tenants (id, display_name, created_by, changed_by) VALUES ($1, $1, 'syn-test', 'syn-test')`, [tenant]);
      for (const [sub, roles, status] of [
        [people.admin, ['admin'], 'active'],
        [people.clinician, ['clinician'], 'active'],
        [people.removed, ['admin'], 'active'],
      ] as const) {
        await c.query(`INSERT INTO tenant_memberships (tenant_id, sub, status, roles, changed_by) VALUES ($1, $2, $3, $4::text[], 'syn-test')`, [tenant, sub, status, roles]);
      }
      await c.query(`UPDATE tenant_memberships SET status = 'removed', changed_by = 'syn-test' WHERE tenant_id = $1 AND sub = $2`, [tenant, people.removed]);
      const row = (type: string, outcome: string, actor: string, route: string, subject: string | null, at: string) =>
        c.query(
          `INSERT INTO security_audit_events (event_type, outcome, tenant_id, actor_sub, route_key, subject_id, request_id, occurred_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [type, outcome, tenant, actor, route, subject, `syn-req-${randomUUID().slice(0, 12)}`, at],
        );
      await row('private-read', 'succeeded', people.clinician, 'PatientsController.get', patient, '2026-11-20T10:00:00Z');
      await row('private-read', 'refused', people.clinician, 'PatientsController.get', other, '2026-11-20T11:00:00Z');
      await row('download-link', 'succeeded', people.clinician, 'ReportsController.downloadUrl', other, '2026-11-20T12:00:00Z');
      await row('private-write', 'accepted', people.clinician, 'PatientsController.replace', patient, '2026-11-20T13:00:00Z');
      await row('api-auth', 'accepted', people.clinician, 'PatientsController.get', null, '2026-11-20T14:00:00Z');
      await row('private-read', 'succeeded', people.admin, 'UsageController.get', null, '2026-11-19T09:00:00Z');
    });
    return { tenant, ...people };
  }

  type Row = { event_type: string; outcome: string; actor_sub: string; route_key: string; subject_id: string | null; occurred_at: Date };
  const review = (tenant: string, actor: string | undefined, args: unknown[] = [null, null, '2026-11-01T00:00:00Z', '2026-12-01T00:00:00Z', 201, 0]) =>
    database.withTenant(
      tenant,
      async (c) =>
        (
          await c.query<Row>(
            `SELECT event_type, outcome, actor_sub, route_key, subject_id::text AS subject_id, occurred_at
               FROM security_audit_review($1::text, $2::uuid[], $3::timestamptz, $4::timestamptz, $5::int, $6::int)`,
            args,
          )
        ).rows,
      actor === undefined ? {} : { actor },
    );
  const brief = (rows: Row[]) => rows.map((r) => `${r.event_type}/${r.outcome} ${r.route_key} ${r.subject_id ?? '-'}`);

  it('T-1: an admin reads the read and download rows of their own organisation, newest first, and never another organisation', async () => {
    const a = await organisation();
    const b = await organisation();
    expect(brief(await review(a.tenant, a.admin))).toEqual([
      `download-link/succeeded ReportsController.downloadUrl ${other}`,
      `private-read/refused PatientsController.get ${other}`,
      `private-read/succeeded PatientsController.get ${patient}`,
      'private-read/succeeded UsageController.get -',
    ]);
    const mine = await review(b.tenant, b.admin);
    expect(mine.every((r) => r.actor_sub.endsWith(b.tenant))).toBe(true);
    expect(mine).toHaveLength(4);
  });

  it('T-2: a clinician, a removed admin, an admin of another organisation and a call with no person bound are refused', async () => {
    const a = await organisation();
    const b = await organisation();
    for (const actor of [a.clinician, a.removed, b.admin]) await expect(review(a.tenant, actor)).rejects.toMatchObject({ code: '42501' });
    await expect(review(a.tenant, undefined)).rejects.toMatchObject({ code: '42501' });
  });

  it('T-3: the member, subject and time filters hold, writes and sign-ins are never returned, and a call returns at most 201 rows', async () => {
    const a = await organisation();
    const window = ['2026-11-20T00:00:00Z', '2026-11-21T00:00:00Z'];
    expect(brief(await review(a.tenant, a.admin, [a.clinician, null, ...window, 201, 0]))).toHaveLength(3);
    expect(brief(await review(a.tenant, a.admin, [null, [patient], ...window, 201, 0]))).toEqual([`private-read/succeeded PatientsController.get ${patient}`]);
    expect(await review(a.tenant, a.admin, [a.admin, null, ...window, 201, 0])).toEqual([]); // the admin's own read was on 2026-11-19
    expect(brief(await review(a.tenant, a.admin, [null, null, ...window, 1, 1]))).toEqual([`private-read/refused PatientsController.get ${other}`]);
    await withAdmin(db.adminUrl, async (c) => {
      for (let i = 0; i < 205; i += 1)
        await c.query(
          `INSERT INTO security_audit_events (event_type, outcome, tenant_id, actor_sub, route_key, subject_id, request_id, occurred_at)
           VALUES ('private-read', 'succeeded', $1, $2, 'PatientsController.get', $3, $4, '2026-11-20T15:00:00Z')`,
          [a.tenant, a.clinician, patient, `syn-bulk-${randomUUID().slice(0, 12)}`],
        );
    });
    expect(await review(a.tenant, a.admin, [null, null, ...window, 1000, 0])).toHaveLength(201);
  });

  it('the application role still cannot read the audit table itself, and cannot call the admin check', async () => {
    const a = await organisation();
    await expect(database.withTenant(a.tenant, (c) => c.query('SELECT count(*) FROM security_audit_events'), { actor: a.admin })).rejects.toMatchObject({ code: '42501' });
    await expect(
      database.withTenant(a.tenant, (c) => c.query('SELECT access_review_admin_current($1, $2)', [a.tenant, a.admin]), { actor: a.admin }),
    ).rejects.toMatchObject({ code: '42501' });
  });
});
