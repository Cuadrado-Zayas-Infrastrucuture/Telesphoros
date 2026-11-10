import type { Client } from 'pg';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';

// One catalog-wide tenant-isolation invariant, read from a database with every migration applied. The other catalog guards check the tables they
// name; this one finds the tables itself, so a new table with a `tenant_id` column is covered on the day it is added.

/**
 * Tables with a `tenant_id` column whose row-level security is enabled but NOT forced, so their owner is not bound by it. Each needs a reason.
 * A table missing from this list must be forced; a table in this list that is forced, or gone, must be taken off it.
 */
const NOT_FORCED: Readonly<Record<string, string>> = {
  ledger_events: '0005: the owner role maintains the ledger through its functions; the application role is bound by a tenant policy',
  ledger_heads: '0005: as ledger_events',
  ledger_checkpoints: '0005: as ledger_events',
  ledger_incidents: '0011: as the other ledger tables; the application role has no policy and no grant',
  security_events: '0046: its writers are SECURITY DEFINER functions and a trigger owned by the migrator, which must keep writing',
  tenant_memberships: '0017: the owner is the migration login the operator command uses, which must read and write across organizations',
  // The migrations of the four below state no reason. They are listed as they are today, not endorsed: each has no application policy
  // or a tenant-bound one, and whether to force them is an open decision (gap GAP-07).
  invitations: '0019: no reason stated; owned by the migration login like tenant_memberships',
  security_audit_events: '0016: no reason stated; only the ledger verifier has a policy',
  tenant_capabilities: '0028: no reason stated; no policy at all, so only the owner sees a row',
  capability_issuance_log: '0028: no reason stated; no policy at all, so only the owner sees a row',
};

/** The roles a request or a job handler runs as. PUBLIC is every role, so a policy for it reaches them too. */
const APPLICATION_ROLES = ['telesphoros_app', 'telesphoros_worker'] as const;
const REACHES_APPLICATION = [...APPLICATION_ROLES, 'public'];
/** `tenant_id = (SELECT app_tenant())`, or the capability-bound `app_tenant_bound()`, as PostgreSQL prints it back. */
const TENANT_PREDICATE = /\(tenant_id = \( SELECT app_tenant(?:_bound)?\(\) AS app_tenant\)\)/;

interface TenantTable {
  relname: string;
  owner: string;
  rls: boolean;
  forced: boolean;
}
interface Policy {
  tablename: string;
  policyname: string;
  permissive: string;
  roles: string[];
  cmd: string;
  qual: string | null;
  with_check: string | null;
}

let pg: EphemeralDatabase;
let tables: TenantTable[];
let policies: Policy[];
const q = <T = Record<string, unknown>>(sql: string, values: unknown[] = []) => withAdmin(pg.adminUrl, async (c: Client) => (await c.query(sql, values)).rows as T[]);

const TENANT_RELATIONS = `SELECT c.oid, c.relname, c.relkind, c.reloptions, pg_get_userbyid(c.relowner) AS owner, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced
  FROM pg_class c
 WHERE c.relnamespace = 'public'::regnamespace
   AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND a.attnum > 0 AND NOT a.attisdropped)`;

beforeAll(async () => {
  pg = await createEphemeralDatabase();
  tables = await q<TenantTable>(`SELECT relname, owner, rls, forced FROM (${TENANT_RELATIONS}) t WHERE relkind IN ('r', 'p') ORDER BY relname`);
  policies = await q<Policy>(
    `SELECT tablename, policyname, permissive, roles::text[] AS roles, cmd, qual, with_check FROM pg_policies WHERE schemaname = 'public' AND tablename = ANY($1) ORDER BY tablename, policyname`,
    [tables.map((t) => t.relname)],
  );
});
afterAll(async () => {
  await pg.drop();
});

const reachesApplication = (p: Policy) => p.roles.some((role) => REACHES_APPLICATION.includes(role));
/**
 * Every expression the policy has must require the caller's tenant: it contains the predicate and no OR, so the predicate cannot be one of
 * two ways in. A policy with no expression at all is not bound.
 */
const tenantBound = (p: Pick<Policy, 'qual' | 'with_check'>): boolean => {
  const expressions = [p.qual, p.with_check].filter((e): e is string => e !== null);
  return expressions.length > 0 && expressions.every((e) => TENANT_PREDICATE.test(e) && !/\bOR\b/.test(e));
};

describe('tenant isolation holds for every table with a tenant_id column, whichever migration added it', () => {
  it('finds the tenant tables itself (a floor, so an empty query cannot pass)', () => {
    expect(tables.length).toBeGreaterThanOrEqual(60);
    expect(tables.map((t) => t.relname)).toEqual(expect.arrayContaining(['patients', 'reports', 'evaluations', 'ledger_events', 'tenant_memberships']));
  });

  it('row-level security is enabled on every one', () => {
    expect(tables.filter((t) => !t.rls).map((t) => t.relname)).toEqual([]);
  });

  it('and forced on every one, except the named tables, each with its reason', () => {
    for (const reason of Object.values(NOT_FORCED)) expect(reason).toMatch(/^\d{4}: \S/);
    // Both directions at once: a new unforced table fails, and so does an exception that is no longer needed.
    expect(tables.filter((t) => !t.forced).map((t) => t.relname)).toEqual(Object.keys(NOT_FORCED).sort());
  });

  it('no application role owns one, is a superuser or bypasses row-level security', async () => {
    expect(tables.filter((t) => (APPLICATION_ROLES as readonly string[]).includes(t.owner)).map((t) => t.relname)).toEqual([]);
    const roles = await q<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
      `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = ANY($1) ORDER BY rolname`,
      [[...APPLICATION_ROLES]],
    );
    expect(roles).toEqual(APPLICATION_ROLES.map((rolname) => ({ rolname, rolsuper: false, rolbypassrls: false })));
  });

  it("every granting policy that reaches an application role requires the caller's tenant in each of its expressions", () => {
    // A restrictive policy narrows and never grants, so only permissive ones are judged.
    const reaching = policies.filter((p) => p.permissive === 'PERMISSIVE' && reachesApplication(p));
    expect(reaching.length).toBeGreaterThanOrEqual(40);
    expect(reaching.filter((p) => !tenantBound(p)).map((p) => `${p.tablename}.${p.policyname}`)).toEqual([]);
  });

  it('a table an application role may touch has a policy for that role, so its access is a stated tenant rule and not an accident', async () => {
    const granted = await q<{ relname: string; rolname: string }>(
      `SELECT c.relname, r.rolname FROM pg_class c CROSS JOIN pg_roles r
        WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY($1) AND r.rolname = ANY($2)
          AND has_table_privilege(r.oid, c.oid, 'SELECT, INSERT, UPDATE, DELETE') ORDER BY c.relname, r.rolname`,
      [tables.map((t) => t.relname), [...APPLICATION_ROLES]],
    );
    expect(granted.length).toBeGreaterThanOrEqual(30);
    const without = granted.filter((g) => !policies.some((p) => p.tablename === g.relname && (p.roles.includes(g.rolname) || p.roles.includes('public'))));
    expect(without.map((g) => `${g.relname} for ${g.rolname}`)).toEqual([]);
  });

  it('a view that shows tenant_id runs as its caller, so the tables beneath it apply their own policies; no materialized view copies tenant rows', async () => {
    const views = await q<{ relname: string; relkind: string; reloptions: string[] | null }>(
      `SELECT relname, relkind, reloptions FROM (${TENANT_RELATIONS}) t WHERE relkind NOT IN ('r', 'p', 'i', 'I') ORDER BY relname`,
    );
    expect(views.map((v) => v.relname)).toContain('structured_report_findings');
    expect(views.filter((v) => v.relkind !== 'v' || !(v.reloptions ?? []).includes('security_invoker=true')).map((v) => v.relname)).toEqual([]);
  });
});

describe('controls: the guard goes red on the mistakes it exists to catch', () => {
  // Each control makes its mistake inside a transaction that is rolled back, and runs the same queries the guard runs.
  const inRollback = <T>(setup: string, read: (c: Client) => Promise<T>) =>
    withAdmin(pg.adminUrl, async (c: Client) => {
      await c.query('BEGIN');
      try {
        await c.query(setup);
        return await read(c);
      } finally {
        await c.query('ROLLBACK');
      }
    });
  const unforcedIn = async (c: Client) =>
    (await c.query<TenantTable>(`SELECT relname, owner, rls, forced FROM (${TENANT_RELATIONS}) t WHERE relkind IN ('r', 'p') AND NOT forced ORDER BY relname`)).rows.map(
      (r) => r.relname,
    );

  it('a new tenant table without forced row-level security is found', async () => {
    const found = await inRollback('CREATE TABLE zz_control_new (id uuid PRIMARY KEY, tenant_id text NOT NULL); ALTER TABLE zz_control_new ENABLE ROW LEVEL SECURITY', unforcedIn);
    expect(found).toContain('zz_control_new');
    expect(found).not.toEqual(Object.keys(NOT_FORCED).sort());
  });

  it('a new tenant table with no row-level security at all is found', async () => {
    const found = await inRollback('CREATE TABLE zz_control_bare (id uuid PRIMARY KEY, tenant_id text NOT NULL)', async (c) =>
      (await c.query<{ relname: string }>(`SELECT relname FROM (${TENANT_RELATIONS}) t WHERE relkind IN ('r', 'p') AND NOT rls`)).rows.map((r) => r.relname),
    );
    expect(found).toEqual(['zz_control_bare']);
  });

  it('an exception that became forced no longer matches the list', async () => {
    const found = await inRollback('ALTER TABLE invitations FORCE ROW LEVEL SECURITY', unforcedIn);
    expect(found).not.toContain('invitations');
    expect(found).not.toEqual(Object.keys(NOT_FORCED).sort());
  });

  it('the rule accepts the two shapes the schema uses, alone or narrowed with AND', () => {
    const bound = '(tenant_id = ( SELECT app_tenant() AS app_tenant))';
    expect(tenantBound({ qual: bound, with_check: null })).toBe(true);
    expect(tenantBound({ qual: null, with_check: '(tenant_id = ( SELECT app_tenant_bound() AS app_tenant))' })).toBe(true);
    expect(tenantBound({ qual: `(${bound} AND (expires_at <= clock_timestamp()))`, with_check: null })).toBe(true);
    expect(tenantBound({ qual: null, with_check: null })).toBe(false);
  });

  it.each([
    ['open to every tenant', `CREATE POLICY zz_control ON patients FOR SELECT TO telesphoros_app USING (true)`],
    ['bound in USING but open in WITH CHECK', `CREATE POLICY zz_control ON patients FOR ALL TO telesphoros_app USING (tenant_id = (SELECT app_tenant())) WITH CHECK (true)`],
    ['tenant-bound OR something else', `CREATE POLICY zz_control ON patients FOR SELECT TO telesphoros_app USING (tenant_id = (SELECT app_tenant()) OR created_by = 'x')`],
    ['for PUBLIC', `CREATE POLICY zz_control ON patients FOR SELECT USING (true)`],
  ])('an application policy that is %s is not tenant-bound', async (_name, setup) => {
    const added = await inRollback(
      setup,
      async (c) =>
        (await c.query<Policy>(`SELECT tablename, policyname, permissive, roles::text[] AS roles, cmd, qual, with_check FROM pg_policies WHERE policyname = 'zz_control'`)).rows,
    );
    expect(added).toHaveLength(1);
    const [policy] = added as [Policy];
    expect(reachesApplication(policy)).toBe(true);
    expect(tenantBound(policy)).toBe(false);
  });
});
