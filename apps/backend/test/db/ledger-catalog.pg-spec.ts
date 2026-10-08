import type { Client } from 'pg';
import { ALL_CLASSIFIED_TABLES, APPEND_ONLY_CLASSES } from '../../src/db/append-only-tables';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';

let pg: EphemeralDatabase;
beforeAll(async () => {
  pg = await createEphemeralDatabase();
});
afterAll(async () => {
  await pg.drop();
});
const q = <T = Record<string, unknown>>(sql: string, values: unknown[] = []) => withAdmin(pg.adminUrl, async (c: Client) => (await c.query(sql, values)).rows as T[]);

const GUARDED = [...APPEND_ONLY_CLASSES.record, ...APPEND_ONLY_CLASSES.child, ...APPEND_ONLY_CLASSES.ledger];
const TENANT_POLICIED = [...APPEND_ONLY_CLASSES.record, ...APPEND_ONLY_CLASSES.child, ...APPEND_ONLY_CLASSES.notes];
const FORCED = [...APPEND_ONLY_CLASSES.record, ...APPEND_ONLY_CLASSES.child, ...APPEND_ONLY_CLASSES.notes];

describe('catalog guard: the audit tables are classified and protected as their class requires', () => {
  it('every table in the public schema is classified, and every classified table exists (a floor on both sides)', async () => {
    const actual = (await q<{ tablename: string }>(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`)).map((r) => r.tablename).sort();
    expect(ALL_CLASSIFIED_TABLES.length).toBeGreaterThanOrEqual(16);
    expect(actual.length).toBeGreaterThanOrEqual(16);
    expect(actual.filter((t) => !ALL_CLASSIFIED_TABLES.includes(t))).toEqual([]); // a new table must be classified in append-only-tables.ts
    expect([...ALL_CLASSIFIED_TABLES].filter((t) => !actual.includes(t))).toEqual([]);
  });

  it('row-level security is enabled on every audit table, and FORCED on every record, child and note table', async () => {
    const rows = await q<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(`SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'`);
    const by = Object.fromEntries(rows.map((r) => [r.relname, r]));
    for (const t of Object.values(APPEND_ONLY_CLASSES).flat()) expect([t, by[t]?.relrowsecurity]).toEqual([t, true]);
    for (const t of FORCED) expect([t, by[t]?.relforcerowsecurity]).toEqual([t, true]);
  });

  it('every guarded table refuses UPDATE/DELETE per row and TRUNCATE per statement', async () => {
    const rows = await q<{ table: string; kind: string; ev: number }>(`
      SELECT c.relname AS "table", p.proname AS kind, t.tgtype::int AS ev FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_proc p ON p.oid = t.tgfoid
       WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal AND p.proname = 'refuse_mutation'`);
    for (const table of GUARDED) {
      const own = rows.filter((r) => r.table === table);
      // tgtype bits: 1 = row, 2 = before, 4 = insert, 8 = delete, 16 = update, 32 = truncate
      expect([table, own.some((r) => r.ev & 1 && r.ev & 2 && r.ev & 8 && r.ev & 16)]).toEqual([table, true]);
      expect([table, own.some((r) => r.ev & 32)]).toEqual([table, true]);
    }
  });

  it('record, child and note tables have a tenant policy for the application and explicit read policies for the ledger and the verifier', async () => {
    const pol = await q<{ tablename: string; policyname: string; roles: string; cmd: string; qual: string; with_check: string | null }>(
      `SELECT tablename, policyname, roles::text, cmd, qual, with_check FROM pg_policies WHERE schemaname = 'public'`);
    for (const table of TENANT_POLICIED) {
      const own = pol.filter((p) => p.tablename === table);
      const app = own.find((p) => p.roles.includes('telesphoros_app'));
      expect([table, app?.qual, app?.with_check]).toEqual([table, expect.stringContaining('app.current_tenant_id'), expect.stringContaining('app.current_tenant_id')]);
      const verifier = own.find((p) => p.roles.includes('telesphoros_ledger_verifier'));
      expect([table, verifier?.cmd]).toEqual([table, 'SELECT']);
      // Forced row-level security blinds even an owner: without its own policy the ledger functions would read ZERO rows of this table.
      const ledger = own.find((p) => p.roles.includes('telesphoros_ledger'));
      expect([table, ledger?.cmd, ledger?.qual]).toEqual([table, 'SELECT', expect.stringContaining('app.current_tenant_id')]);
    }
  });

  it('the application role holds exactly SELECT and INSERT on record, child and note tables, and SELECT on the ledger; nothing else', async () => {
    const grants = await q<{ table_name: string; privilege_type: string; grantee: string }>(`SELECT table_name, privilege_type, grantee FROM information_schema.role_table_grants WHERE table_schema = 'public' AND grantee = 'telesphoros_app'`);
    const forTable = (t: string) => grants.filter((g) => g.table_name === t).map((g) => g.privilege_type).sort();
    for (const t of TENANT_POLICIED) expect([t, forTable(t)]).toEqual([t, ['INSERT', 'SELECT']]);
    for (const t of [...APPEND_ONLY_CLASSES.ledger, ...APPEND_ONLY_CLASSES.head]) expect([t, forTable(t)]).toEqual([t, ['SELECT']]);
  });

  it('nobody but the redactor holds UPDATE on any audit table, and the redactor only on three columns of event_notes', async () => {
    const tableUpdate = await q<{ table_name: string; grantee: string }>(`SELECT table_name, grantee FROM information_schema.role_table_grants WHERE table_schema = 'public' AND privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE') AND table_name = ANY($1)`,
      [Object.values(APPEND_ONLY_CLASSES).flat()]);
    // Table owners hold everything by definition; what must hold is that no OTHER role does.
    const owners = new Set((await q<{ o: string }>(`SELECT DISTINCT pg_get_userbyid(relowner) AS o FROM pg_class WHERE relnamespace = 'public'::regnamespace`)).map((r) => r.o));
    expect(tableUpdate.filter((g) => !owners.has(g.grantee) && g.grantee !== 'telesphoros_ledger')).toEqual([]);
    const columns = await q<{ column_name: string; grantee: string }>(`SELECT column_name, grantee FROM information_schema.column_privileges WHERE table_schema = 'public' AND table_name = 'event_notes' AND privilege_type = 'UPDATE' AND grantee = 'telesphoros_redactor'`);
    expect(columns.map((c) => c.column_name).sort()).toEqual(['body', 'redacted_at', 'redaction_basis_code']);
  });

  it('every record table carries tenant_id, created_by, ledger_event_id and seq; every child carries tenant_id', async () => {
    const cols = await q<{ table_name: string; column_name: string }>(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`);
    const has = (t: string, c: string) => cols.some((x) => x.table_name === t && x.column_name === c);
    for (const t of APPEND_ONLY_CLASSES.record) for (const c of ['tenant_id', 'created_by', 'ledger_event_id', 'seq']) expect([t, c, has(t, c)]).toEqual([t, c, true]);
    for (const t of APPEND_ONLY_CLASSES.child) expect([t, has(t, 'tenant_id')]).toEqual([t, true]);
  });

  it('every record table has its deferred "described by its own event" trigger', async () => {
    const rows = await q<{ table: string }>(`SELECT c.relname AS "table" FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_proc p ON p.oid = t.tgfoid
                                              WHERE p.proname = 'ledger_row_has_event' AND t.tgdeferrable AND t.tginitdeferred`);
    expect(rows.map((r) => r.table).sort()).toEqual([...APPEND_ONLY_CLASSES.record, 'ledger_checkpoints'].sort());
  });

  it('every SECURITY DEFINER function pins its search_path, and the privileged functions have exactly the expected owners and callers', async () => {
    const fns = await q<{ name: string; owner: string; definer: boolean; config: string[] | null; acl: string[] | null }>(`
      SELECT p.proname AS name, pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer, p.proconfig AS config, p.proacl::text[] AS acl
        FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace`);
    expect(fns.length).toBeGreaterThanOrEqual(10);
    for (const f of fns) if (f.definer) expect([f.name, (f.config ?? []).some((c) => c.startsWith('search_path=pg_catalog'))]).toEqual([f.name, true]);
    const callers = async (name: string) => (await q<{ g: string }>(`
      SELECT DISTINCT CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS g
        FROM pg_proc p, LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
       WHERE p.pronamespace = 'public'::regnamespace AND p.proname = $1 AND a.privilege_type = 'EXECUTE'`, [name])).map((r) => r.g).filter((g) => g.startsWith('telesphoros_') || g === 'PUBLIC').sort();
    const owner = (name: string) => fns.find((f) => f.name === name)?.owner;
    expect([owner('ledger_append'), await callers('ledger_append')]).toEqual(['telesphoros_ledger', ['telesphoros_app', 'telesphoros_ledger']]);
    expect([owner('ledger_append_internal'), await callers('ledger_append_internal')]).toEqual(['telesphoros_ledger', ['telesphoros_ledger', 'telesphoros_redactor']]);
    expect([owner('ledger_record_checkpoint'), await callers('ledger_record_checkpoint')]).toEqual(['telesphoros_ledger', ['telesphoros_ledger', 'telesphoros_ledger_verifier']]);
    expect([owner('redact_event_note'), await callers('redact_event_note')]).toEqual(['telesphoros_redactor', ['telesphoros_ledger_operator', 'telesphoros_redactor']]);
    for (const name of ['ledger_row_has_event', 'ledger_event_row_exists', 'ledger_heads_guard', 'event_notes_guard', 'evaluation_child_guard']) {
      expect([name, (await callers(name)).includes('PUBLIC')]).toEqual([name, false]);
    }
  });

  it('every foreign key in the audit design is ON DELETE RESTRICT, and the verifier is not in the application role', async () => {
    const fks = await q<{ conname: string; confdeltype: string }>(`SELECT conname, confdeltype FROM pg_constraint WHERE contype = 'f' AND connamespace = 'public'::regnamespace`);
    expect(fks.length).toBeGreaterThan(20);
    expect(fks.filter((f) => f.confdeltype !== 'r').map((f) => f.conname)).toEqual([]);
    const members = await q<{ r: string }>(`SELECT pg_get_userbyid(roleid) AS r FROM pg_auth_members WHERE member = 'telesphoros_ledger_verifier'::regrole`);
    expect(members).toEqual([]);
  });
});
