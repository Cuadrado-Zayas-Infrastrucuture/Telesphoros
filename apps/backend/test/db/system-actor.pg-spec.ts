import type { Client } from 'pg';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';
import { registerTenantRow } from '../helpers/membership';

/**
 * M2.3a pins: a background job acts as `system:<job type>`, and that name can never stand in for a person. The independence rules ("someone other than who
 * registered it", "a second person") compare identities, so an identity no person can hold would satisfy every one of them. The database therefore refuses the
 * name on every table that records a human decision or assertion, and on memberships.
 */
let db: EphemeralDatabase;
beforeAll(async () => {
  db = await createEphemeralDatabase();
});
afterAll(async () => db?.drop());
const owner = <T>(work: (c: Client) => Promise<T>) => withAdmin(db.adminUrl, work);

const HUMAN_ONLY = [
  'capture_acceptances',
  'cell_disputes',
  'cell_dispute_decisions',
  'corrections',
  'report_patient_decisions',
  'patient_merge_proposals',
  'patient_merge_decisions',
  'patient_identifiers',
];

describe('the human-actor rule in the database', () => {
  it.each(HUMAN_ONLY)('%s carries a validated CHECK that refuses a created_by starting "system:"', async (table) => {
    const rows = await owner((c) =>
      c
        .query(`SELECT pg_get_constraintdef(oid) AS def, convalidated FROM pg_constraint WHERE conrelid = $1::regclass AND conname = $2`, [table, `${table}_created_by_human`])
        .then((r) => r.rows),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].convalidated).toBe(true);
    // A withdrawal is a person's decision too.
    expect(rows[0].def).toBe(
      table === 'patient_identifiers'
        ? `CHECK (((created_by !~ '^system:'::text) AND ((withdrawn_by IS NULL) OR (withdrawn_by !~ '^system:'::text))))`
        : `CHECK ((created_by !~ '^system:'::text))`,
    );
  });

  it('is exercised by the constraint itself: the same expression refuses the names a job acts under and accepts a person', async () => {
    const verdicts = await owner((c) =>
      c
        .query(
          `SELECT v, v !~ '^system:' AS ok FROM unnest(ARRAY['system:uploads.sweep', 'system:', 'system:scheduler', 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', 'systemic', 'a:system:b', 'System:x']) AS v`,
        )
        .then((r) => r.rows),
    );
    expect(verdicts.map((r) => [r.v, r.ok])).toEqual([
      ['system:uploads.sweep', false],
      ['system:', false],
      ['system:scheduler', false],
      ['aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', true],
      ['systemic', true],
      ['a:system:b', true],
      ['System:x', true],
    ]);
  });

  it('refuses a membership whose subject is a system actor, however it is inserted, and accepts a person', async () => {
    await owner(async (c) => {
      await registerTenantRow(c, 'tenant-system-actor');
      for (const sub of ['system:uploads.sweep', 'system:']) {
        await expect(
          c.query(`INSERT INTO tenant_memberships (tenant_id, sub, status, roles, changed_by) VALUES ('tenant-system-actor', $1, 'active', '{admin}', 'test')`, [sub]),
        ).rejects.toThrow(/tenant_memberships_sub_human/);
      }
      await expect(
        c.query(`INSERT INTO tenant_memberships (tenant_id, sub, status, roles, changed_by) VALUES ('tenant-system-actor', 'a-person', 'active', '{admin}', 'test')`),
      ).resolves.toBeDefined();
      await expect(c.query(`UPDATE tenant_memberships SET sub = 'system:x' WHERE sub = 'a-person'`)).rejects.toThrow(/cannot change its organization, person/); // a person's name cannot be changed into a system actor's either
    });
  });
});

describe('what a job records', () => {
  it('names the scheduler and the person who asked, and the person comes from the transaction', async () => {
    await owner(async (c) => {
      await registerTenantRow(c, 'tenant-system-actor-2');
      await c.query(`INSERT INTO job_schedules (type, interval_seconds) VALUES ('test.echo', 3600)`);
      await c.query(`SELECT job_schedule_tick()`);
      const { rows } = await c.query(`SELECT requested_by FROM jobs WHERE tenant_id = 'tenant-system-actor-2' AND type = 'test.echo'`);
      expect(rows).toEqual([{ requested_by: 'system:scheduler' }]);
    });
  });
});
