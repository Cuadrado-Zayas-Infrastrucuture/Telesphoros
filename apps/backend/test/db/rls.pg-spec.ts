import { Pool } from 'pg';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';

type Row = Record<string, string | number | boolean | null>;
let db: EphemeralDatabase;
let app: Pool;
let sharedConnection: Pool; // ONE connection, to prove settings cannot leak between transactions

beforeAll(async () => {
  db = await createEphemeralDatabase();
  app = new Pool({ connectionString: db.appUrl, max: 4 });
  sharedConnection = new Pool({ connectionString: db.appUrl, max: 1 });
  // Seed through the admin connection (which bypasses RLS) so the app role has something it must NOT see.
  await withAdmin(db.adminUrl, async (c) => {
    for (const owner of ['alice', 'bob']) {
      const p = await c.query(`INSERT INTO patients (owner_id, label) VALUES ($1, $2) RETURNING id`, [owner, `SYN-${owner}`]);
      await c.query(`INSERT INTO reports (owner_id, patient_id, type, original_filename, size_bytes) VALUES ($1, $2, 'vcf', 'a.vcf', 5)`, [owner, p.rows[0].id]);
    }
  });
});
afterAll(async () => {
  await app.end();
  await sharedConnection.end();
  await db.drop();
});

/** Runs SQL as the application role inside a transaction owned by `owner` (or none). */
async function asApp<T>(owner: string | null, work: (q: (sql: string, params?: unknown[]) => Promise<{ rows: Row[]; rowCount: number | null }>) => Promise<T>, pool = app) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (owner !== null) await client.query(`SELECT set_config('app.current_owner_id', $1, true)`, [owner]);
    const result = await work((sql, params) => client.query(sql, params));
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
const code = (promise: Promise<unknown>) => promise.then(() => undefined, (e: { code?: string }) => e.code);

describe('the application role is constrained', () => {
  it('is not a superuser, cannot bypass RLS, and does not own the tables', async () => {
    const role = await asApp('alice', (q) => q(`SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = current_user`));
    expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false });
    const owners = await asApp('alice', (q) => q(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tableowner = current_user`));
    expect(owners.rows).toEqual([]);
  });

  it('cannot DELETE, TRUNCATE, change the schema, or switch off RLS', async () => {
    expect(await code(asApp('alice', (q) => q('DELETE FROM patients')))).toBe('42501');
    expect(await code(asApp('alice', (q) => q('TRUNCATE patients CASCADE')))).toBe('42501');
    expect(await code(asApp('alice', (q) => q('ALTER TABLE patients DISABLE ROW LEVEL SECURITY')))).toBe('42501');
    expect(await code(asApp('alice', (q) => q('DROP TABLE reports')))).toBe('42501');
    expect(await code(asApp('alice', (q) => q('CREATE TABLE sneaky (x int)')))).toBe('42501');
    expect(await code(asApp('alice', (q) => q('SET ROLE postgres')))).toBe('42501');
    expect(await code(asApp('alice', (q) => q(`SET session_replication_role = 'replica'`)))).toBe('42501');
    expect(await code(asApp('alice', (q) => q(`UPDATE recommendations SET gene = 'X'`)))).toBe('42501'); // never updated
  });
});

describe('row-level security fails closed and isolates owners', () => {
  it('with NO owner set the role sees nothing, even though rows exist', async () => {
    for (const table of ['patients', 'reports', 'recommendations']) {
      expect((await asApp(null, (q) => q(`SELECT * FROM ${table}`))).rows).toEqual([]);
    }
    const total = await withAdmin(db.adminUrl, (c) => c.query('SELECT count(*)::int AS n FROM patients'));
    expect(total.rows[0].n).toBe(2);
  });

  it('with an owner set, even an unfiltered SELECT returns only that owner’s rows', async () => {
    const alice = await asApp('alice', (q) => q('SELECT owner_id FROM patients'));
    expect(alice.rows).toEqual([{ owner_id: 'alice' }]);
    const reports = await asApp('bob', (q) => q('SELECT owner_id FROM reports'));
    expect(reports.rows).toEqual([{ owner_id: 'bob' }]);
  });

  it('cannot read, modify or reassign another owner’s row, even when naming its id', async () => {
    const bobsId = (await withAdmin(db.adminUrl, (c) => c.query(`SELECT id FROM patients WHERE owner_id = 'bob'`))).rows[0].id;
    expect((await asApp('alice', (q) => q('SELECT * FROM patients WHERE id = $1', [bobsId]))).rows).toEqual([]);
    expect((await asApp('alice', (q) => q(`UPDATE patients SET label = 'HACKED' WHERE id = $1`, [bobsId]))).rowCount).toBe(0);
    const still = await withAdmin(db.adminUrl, (c) => c.query('SELECT label FROM patients WHERE id = $1', [bobsId]));
    expect(still.rows[0].label).toBe('SYN-bob');
  });

  it('cannot write a row for someone else, or hand its own row to someone else', async () => {
    expect(await code(asApp('alice', (q) => q(`INSERT INTO patients (owner_id, label) VALUES ('bob', 'SYN-STOLEN')`)))).toBe('42501');
    expect(await code(asApp('alice', (q) => q(`UPDATE patients SET owner_id = 'bob'`)))).toBe('42501');
  });

  it('cannot see through a UNION / subquery / function trick: policy applies to every table scan', async () => {
    const res = await asApp('alice', (q) =>
      q(`SELECT owner_id FROM patients UNION ALL SELECT owner_id FROM reports UNION ALL SELECT owner_id FROM recommendations`),
    );
    expect(new Set(res.rows.map((r) => r.owner_id))).toEqual(new Set(['alice']));
  });

  it('the owner setting is transaction-local: it does not leak to the next request on a pooled connection', async () => {
    const first = await asApp('alice', (q) => q('SELECT count(*)::int AS n FROM patients'), sharedConnection);
    expect(first.rows[0].n).toBe(1);
    const next = await asApp(null, (q) => q('SELECT count(*)::int AS n FROM patients'), sharedConnection); // same physical connection
    expect(next.rows[0].n).toBe(0);
    const setting = await asApp(null, (q) => q(`SELECT current_setting('app.current_owner_id', true) AS v`), sharedConnection);
    expect(setting.rows[0].v === null || setting.rows[0].v === '').toBe(true);
  });
});
