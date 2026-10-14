import type { Client } from 'pg';
import { ALL_CLASSIFIED_TABLES, APPEND_ONLY_CLASSES, AUTHORITY_TABLES, JOB_TABLES, MUTABLE_OPERATIONAL_TABLES, OUTBOX_TABLES, VERIFICATION_TABLES, PATIENT_DUPLICATE_TABLES, PATIENT_IDENTITY_TABLES, SECURITY_AUDIT_TABLES } from '../../src/db/append-only-tables';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';

let pg: EphemeralDatabase;
beforeAll(async () => {
  pg = await createEphemeralDatabase();
});
afterAll(async () => {
  await pg.drop();
});
const q = <T = Record<string, unknown>>(sql: string, values: unknown[] = []) => withAdmin(pg.adminUrl, async (c: Client) => (await c.query(sql, values)).rows as T[]);

const GUARDED = [...APPEND_ONLY_CLASSES.record, ...APPEND_ONLY_CLASSES.child, ...APPEND_ONLY_CLASSES.ledger, ...APPEND_ONLY_CLASSES.incident, ...APPEND_ONLY_CLASSES.security];
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

  it('local operational state has forced tenant RLS and no application DELETE/TRUNCATE privilege',async()=>{
    const tables=await q<{relname:string;relrowsecurity:boolean;relforcerowsecurity:boolean}>("SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relnamespace='public'::regnamespace AND relname=ANY($1)",[[...MUTABLE_OPERATIONAL_TABLES]]);
    expect(tables).toHaveLength(2);for(const t of tables)expect(t).toMatchObject({relrowsecurity:true,relforcerowsecurity:true});
    const grants=await q<{table_name:string;privilege_type:string}>("SELECT table_name,privilege_type FROM information_schema.role_table_grants WHERE table_schema='public' AND grantee='telesphoros_app' AND table_name=ANY($1)",[[...MUTABLE_OPERATIONAL_TABLES]]);
    for(const table of MUTABLE_OPERATIONAL_TABLES)expect(grants.filter(g=>g.table_name===table).map(g=>g.privilege_type).sort()).toEqual(['INSERT','SELECT','UPDATE']);
    const policies=await q<{tablename:string;qual:string;with_check:string}>("SELECT tablename,qual,with_check FROM pg_policies WHERE schemaname='public' AND tablename=ANY($1)",[[...MUTABLE_OPERATIONAL_TABLES]]);expect(policies).toHaveLength(2);for(const p of policies){expect(p.qual).toContain('app.current_tenant_id');expect(p.with_check).toContain('app.current_tenant_id');}
  });

  it('patient identifiers have forced tenant RLS, may be read and registered by the application, and can be changed by it only to withdraw (a column grant), never deleted or truncated', async () => {
    const tables = await q<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(`SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = ANY($1)`, [[...PATIENT_IDENTITY_TABLES]]);
    expect(tables).toHaveLength(PATIENT_IDENTITY_TABLES.length);
    for (const t of tables) expect(t).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
    for (const table of PATIENT_IDENTITY_TABLES) {
      const grants = await q<{ privilege_type: string }>(`SELECT privilege_type FROM information_schema.role_table_grants WHERE table_schema = 'public' AND grantee = 'telesphoros_app' AND table_name = $1 ORDER BY privilege_type`, [table]);
      expect(grants.map((g) => g.privilege_type)).toEqual(['INSERT', 'SELECT']); // no table-wide UPDATE, DELETE or TRUNCATE
      const updatable = await q<{ column_name: string }>(`SELECT column_name FROM information_schema.column_privileges WHERE table_schema = 'public' AND grantee = 'telesphoros_app' AND table_name = $1 AND privilege_type = 'UPDATE' ORDER BY column_name`, [table]);
      expect(updatable.map((c) => c.column_name)).toEqual(['status', 'withdrawn_at', 'withdrawn_by']);
      const policies = await q<{ cmd: string; roles: string; qual: string; with_check: string }>(`SELECT cmd, roles::text, qual, with_check FROM pg_policies WHERE schemaname = 'public' AND tablename = $1`, [table]);
      expect(policies).toHaveLength(1);
      expect(policies[0]).toMatchObject({ cmd: 'ALL' });
      expect(policies[0]!.roles).toContain('telesphoros_app');
      expect(policies[0]!.qual).toContain('app.current_tenant_id');
      expect(policies[0]!.with_check).toContain('app.current_tenant_id');
    }
  });

  it('duplicate flags have forced tenant RLS, may be read and added by the application and nothing else, and refuse even the owner an edit, a delete or a truncate', async () => {
    const tables = await q<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(`SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = ANY($1)`, [[...PATIENT_DUPLICATE_TABLES]]);
    expect(tables).toHaveLength(PATIENT_DUPLICATE_TABLES.length);
    for (const t of tables) expect(t).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
    for (const table of PATIENT_DUPLICATE_TABLES) {
      const grants = await q<{ privilege_type: string }>(`SELECT privilege_type FROM information_schema.role_table_grants WHERE table_schema = 'public' AND grantee = 'telesphoros_app' AND table_name = $1 ORDER BY privilege_type`, [table]);
      expect(grants.map((g) => g.privilege_type)).toEqual(['INSERT', 'SELECT']);
      const updatable = await q<{ column_name: string }>(`SELECT column_name FROM information_schema.column_privileges WHERE table_schema = 'public' AND grantee = 'telesphoros_app' AND table_name = $1 AND privilege_type = 'UPDATE'`, [table]);
      expect(updatable).toEqual([]); // not even a column grant: a flag is never changed
      const policies = await q<{ cmd: string; roles: string; qual: string; with_check: string }>(`SELECT cmd, roles::text, qual, with_check FROM pg_policies WHERE schemaname = 'public' AND tablename = $1`, [table]);
      expect(policies).toHaveLength(1);
      expect(policies[0]).toMatchObject({ cmd: 'ALL' });
      expect(policies[0]!.qual).toContain('app.current_tenant_id');
      expect(policies[0]!.with_check).toContain('app.current_tenant_id');
      const triggers = await q<{ tgname: string }>(`SELECT t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relname = $1 AND NOT t.tgisinternal ORDER BY 1`, [table]);
      expect(triggers.map((t) => t.tgname)).toEqual(['patient_duplicate_flags_append_only', 'patient_duplicate_flags_no_truncate']);
    }
  });

  it('the job tables are forced-RLS, readable (own organization) but never writable by the application or the worker, and the history is append-only', async () => {
    const tables = await q<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean; owner: string }>(`SELECT relname, relrowsecurity, relforcerowsecurity, pg_get_userbyid(relowner) AS owner FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = ANY($1) ORDER BY relname`, [[...JOB_TABLES]]);
    expect(tables.map((t) => t.relname)).toEqual([...JOB_TABLES].sort());
    for (const t of tables) expect(t.owner).toBe('telesphoros_jobs');
    for (const t of tables.filter((x) => ['jobs', 'job_attempts'].includes(x.relname))) expect(t).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
    const grants = await q<{ table_name: string; grantee: string; privilege_type: string }>(`SELECT table_name, grantee, privilege_type FROM information_schema.role_table_grants WHERE table_schema = 'public' AND grantee IN ('telesphoros_app', 'telesphoros_worker') AND table_name = ANY($1) ORDER BY 1, 2, 3`, [[...JOB_TABLES]]);
    expect(grants.map((g) => `${g.table_name}:${g.grantee}:${g.privilege_type}`)).toEqual(['job_attempts:telesphoros_app:SELECT', 'job_attempts:telesphoros_worker:SELECT', 'jobs:telesphoros_app:SELECT', 'jobs:telesphoros_worker:SELECT']);
    const policies = await q<{ tablename: string; cmd: string; roles: string }>(`SELECT tablename, cmd, roles::text FROM pg_policies WHERE schemaname = 'public' AND tablename = ANY($1) ORDER BY 1, 3`, [[...JOB_TABLES]]);
    expect(policies.map((p) => `${p.tablename}:${p.cmd}:${p.roles}`).sort()).toEqual(
      ['job_attempts:ALL:{telesphoros_jobs}', 'job_attempts:SELECT:{telesphoros_app,telesphoros_worker}', 'jobs:ALL:{telesphoros_jobs}', 'jobs:SELECT:{telesphoros_app,telesphoros_worker}'],
    );
    const history = await q<{ ev: number }>(`SELECT t.tgtype::int AS ev FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_proc p ON p.oid = t.tgfoid WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal AND p.proname = 'refuse_mutation' AND c.relname = 'job_attempts'`);
    expect(history.some((r) => r.ev & 1 && r.ev & 2 && (r.ev & 8) && (r.ev & 16))).toBe(true); // row, before, delete and update
    expect(history.some((r) => r.ev & 32)).toBe(true); // truncate
  });

  it('the outbox and the verification record are owned by the queue role, forced-RLS, closed to the application except through functions, and never deleted', async () => {
    const tables = await q<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean; owner: string }>(`SELECT relname, relrowsecurity, relforcerowsecurity, pg_get_userbyid(relowner) AS owner FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = ANY($1) ORDER BY relname`, [[...OUTBOX_TABLES, ...VERIFICATION_TABLES]]);
    expect(tables.map((t) => t.relname)).toEqual([...OUTBOX_TABLES, ...VERIFICATION_TABLES].sort());
    for (const t of tables) expect(t.owner).toBe('telesphoros_jobs');
    for (const t of tables.filter((x) => x.relname !== 'outbox_routes')) expect(t).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
    const grants = await q<{ table_name: string; grantee: string; privilege_type: string }>(`SELECT table_name, grantee, privilege_type FROM information_schema.role_table_grants WHERE table_schema = 'public' AND grantee IN ('telesphoros_app', 'telesphoros_worker') AND table_name = ANY($1) ORDER BY 1, 2, 3`, [[...OUTBOX_TABLES, ...VERIFICATION_TABLES]]);
    expect(grants.map((g) => `${g.table_name}:${g.grantee}:${g.privilege_type}`)).toEqual(['file_verifications:telesphoros_app:SELECT']);
    const triggers = await q<{ table: string; fn: string; ev: number }>(`SELECT c.relname AS "table", p.proname AS fn, t.tgtype::int AS ev FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_proc p ON p.oid = t.tgfoid WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal AND c.relname = ANY($1)`, [['outbox_events', 'file_verifications']]);
    for (const table of ['outbox_events', 'file_verifications']) {
      const own = triggers.filter((r) => r.table === table);
      expect([table, own.some((r) => r.ev & 1 && r.ev & 2 && r.ev & 8)]).toEqual([table, true]); // row, before, delete
      expect([table, own.some((r) => r.ev & 32)]).toEqual([table, true]); // truncate
    }
  });

  it('authority tables are read-only to the application, tenant-scoped, and never deleted', async () => {
    const tables = await q<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(`SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = ANY($1)`, [[...AUTHORITY_TABLES]]);
    expect(tables).toHaveLength(AUTHORITY_TABLES.length);
    // Not forced on purpose: the owner (the operator command's login) must write across organizations; the application role is bound by the policy.
    for (const t of tables) expect(t).toMatchObject({ relrowsecurity: true, relforcerowsecurity: false });
    const grants = await q<{ table_name: string; privilege_type: string }>(`SELECT table_name, privilege_type FROM information_schema.role_table_grants WHERE table_schema = 'public' AND grantee = 'telesphoros_app' AND table_name = ANY($1)`, [[...AUTHORITY_TABLES]]);
    for (const table of AUTHORITY_TABLES) expect(grants.filter((g) => g.table_name === table).map((g) => g.privilege_type)).toEqual(['SELECT']);
    const policies = await q<{ tablename: string; cmd: string; roles: string; qual: string }>(`SELECT tablename, cmd, roles::text, qual FROM pg_policies WHERE schemaname = 'public' AND tablename = ANY($1)`, [[...AUTHORITY_TABLES]]);
    // One policy per table for the application, plus the single read-everything policy the queue's definer role needs to know which organizations are active.
    const forApplication = policies.filter((p) => p.roles.includes('telesphoros_app'));
    expect(forApplication).toHaveLength(AUTHORITY_TABLES.length);
    for (const p of forApplication) {
      expect(p.cmd).toBe('SELECT');
      expect(p.qual).toContain('app.current_tenant_id');
    }
    expect(policies.filter((p) => !p.roles.includes('telesphoros_app'))).toEqual([{ tablename: 'tenants', cmd: 'SELECT', roles: '{telesphoros_jobs}', qual: 'true' }]);
    const triggers = await q<{ table: string; ev: number }>(`SELECT c.relname AS "table", t.tgtype::int AS ev FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal AND c.relname = ANY($1)`, [[...AUTHORITY_TABLES]]);
    for (const table of AUTHORITY_TABLES) {
      const own = triggers.filter((r) => r.table === table);
      expect([table, own.some((r) => r.ev & 1 && r.ev & 2 && r.ev & 8)]).toEqual([table, true]); // row, before, delete
      expect([table, own.some((r) => r.ev & 32)]).toEqual([table, true]); // truncate
    }
  });

  it('security-event tables are append-only, closed to the application role, and readable only by the auditor', async () => {
    const triggers = await q<{ table: string; ev: number }>(`SELECT c.relname AS "table", t.tgtype::int AS ev FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_proc p ON p.oid = t.tgfoid
       WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal AND p.proname = 'refuse_mutation' AND c.relname = ANY($1)`, [[...SECURITY_AUDIT_TABLES]]);
    for (const table of SECURITY_AUDIT_TABLES) {
      const own = triggers.filter((r) => r.table === table);
      expect([table, own.some((r) => r.ev & 1 && r.ev & 2 && r.ev & 8 && r.ev & 16)]).toEqual([table, true]); // row, before, delete and update
      expect([table, own.some((r) => r.ev & 32)]).toEqual([table, true]); // truncate
    }
    const grants = await q<{ table_name: string; grantee: string; privilege_type: string }>(`SELECT table_name, grantee, privilege_type FROM information_schema.role_table_grants WHERE table_schema = 'public' AND table_name = ANY($1) AND grantee <> current_user`, [[...SECURITY_AUDIT_TABLES]]);
    for (const table of SECURITY_AUDIT_TABLES) expect(grants.filter((g) => g.table_name === table).map((g) => `${g.grantee}:${g.privilege_type}`)).toEqual(['telesphoros_security_auditor:SELECT']);
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
    expect([owner('ledger_record_incident'), await callers('ledger_record_incident')]).toEqual(['telesphoros_ledger', ['telesphoros_ledger', 'telesphoros_ledger_verifier']]);
    expect([owner('ledger_set_global_hold'), await callers('ledger_set_global_hold')]).toEqual(['telesphoros_ledger', ['telesphoros_ledger', 'telesphoros_ledger_operator']]);
    expect([owner('ledger_clear_incident'), await callers('ledger_clear_incident')]).toEqual(['telesphoros_ledger', ['telesphoros_ledger', 'telesphoros_ledger_operator']]);
    expect([owner('redact_event_note'), await callers('redact_event_note')]).toEqual(['telesphoros_redactor', ['telesphoros_ledger_operator', 'telesphoros_redactor']]);
    for (const name of ['ledger_row_has_event', 'ledger_event_row_exists', 'ledger_heads_guard', 'event_notes_guard', 'evaluation_child_guard']) {
      expect([name, (await callers(name)).includes('PUBLIC')]).toEqual([name, false]);
    }
  });

  it('the application role can execute exactly ONE ledger function, the gate: not the internal appender, and nothing that records, holds or clears an incident', async () => {
    const reachable = await q<{ proname: string }>(`SELECT p.proname FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND has_function_privilege('telesphoros_app', p.oid, 'EXECUTE') AND p.proname LIKE 'ledger\\_%'`);
    expect(reachable.map((r) => r.proname).sort()).toEqual(['ledger_append']);
    expect((await q<{ ok: boolean }>(`SELECT has_function_privilege('telesphoros_app', 'ledger_append_internal(uuid, text, text, uuid, text, smallint)', 'EXECUTE') AS ok`))[0]!.ok).toBe(false);
  });

  it('the incident tables are insert-protected for every login (only the functions write them) and invisible to the application role', async () => {
    const grants = await q<{ table_name: string; grantee: string; privilege_type: string }>(`SELECT table_name, grantee, privilege_type FROM information_schema.role_table_grants WHERE table_schema = 'public' AND table_name = ANY($1)`,
      [APPEND_ONLY_CLASSES.incident]);
    const byRole = (role: string) => grants.filter((g) => g.grantee === role).map((g) => g.privilege_type);
    expect(byRole('telesphoros_app')).toEqual([]);
    expect(byRole('PUBLIC')).toEqual([]);
    for (const role of ['telesphoros_ledger_verifier', 'telesphoros_ledger_operator']) expect(new Set(byRole(role))).toEqual(new Set(['SELECT']));
  });

  it('every foreign key in the audit design is ON DELETE RESTRICT, and the verifier is not in the application role', async () => {
    const fks = await q<{ conname: string; confdeltype: string }>(`SELECT conname, confdeltype FROM pg_constraint WHERE contype = 'f' AND connamespace = 'public'::regnamespace`);
    expect(fks.length).toBeGreaterThan(20);
    expect(fks.filter((f) => f.confdeltype !== 'r').map((f) => f.conname)).toEqual([]);
    const members = await q<{ r: string }>(`SELECT pg_get_userbyid(roleid) AS r FROM pg_auth_members WHERE member = 'telesphoros_ledger_verifier'::regrole`);
    expect(members).toEqual([]);
  });
});
