import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { migrateDown } from '../../src/db/migrator';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';
import { registerTenantRow } from '../helpers/membership';
import { revertThrough } from '../helpers/migration-history';

/**
 * Migration 0048 (LLM harness 3b-1): the receipt of an explanation run is stored by three functions and nothing else. Every hostile case sits next to a positive control that
 * succeeds in the same state, and the immutability and retention cases run as the NOLOGIN owner (no superuser), because a superuser would pass whatever the guard did.
 * Data is synthetic and written by hand. Nothing here is clinical data.
 */
jest.setTimeout(180_000);

type Json = Record<string, unknown>;
let db: EphemeralDatabase;
const owner = <T>(work: (c: Client) => Promise<T>) => withAdmin(db.adminUrl, work);
const token = () => randomBytes(32).toString('base64url');
const hashOf = (value: string) => createHash('sha256').update(value, 'utf8').digest();
const hex = (ch: string) => ch.repeat(64);
const HMAC = (ch: string) => `hmac-sha256:${hex(ch)}`;
const SHA = (ch: string) => `sha256:${hex(ch)}`;

const TENANT_A = 'rcpt-a';
const TENANT_B = 'rcpt-b';
const ACTOR_A = 'rcpt-a-alice';
const ACTOR_B = 'rcpt-b-bob';

async function member(tenant: string, sub: string): Promise<void> {
  await owner(async (c) => {
    await registerTenantRow(c, tenant);
    await c.query(`INSERT INTO tenant_memberships (tenant_id, sub, status, roles, changed_by) VALUES ($1, $2, 'active', ARRAY['reader'], 'test') ON CONFLICT DO NOTHING`, [
      tenant,
      sub,
    ]);
  });
}
/** Mints through the issuer login and commits, as the real issuer does before the API opens its transaction. */
async function mint(tenant: string, sub: string): Promise<string> {
  const value = token();
  const c = new Client({ connectionString: db.issuerUrl });
  await c.connect();
  try {
    const { rows } = await c.query<{ refusal: string | null }>('SELECT * FROM tenant_capability_issue($1, $2, $3, $4, $5, $6)', [
      tenant,
      sub,
      1,
      'request',
      hashOf(value),
      `req-${randomUUID().slice(0, 12)}`,
    ]);
    expect(rows[0]!.refusal).toBeNull();
  } finally {
    await c.end();
  }
  return value;
}
/** A login (the application by default), one transaction with a presented capability, committed so the receipt persists. */
async function as<T>(url: string, capability: string | undefined, work: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    await c.query('BEGIN');
    if (capability !== undefined) await c.query(`SELECT set_config('app.capability', $1, true)`, [capability]);
    const result = await work(c);
    await c.query('COMMIT');
    return result;
  } catch (error) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await c.end();
  }
}
const call = async (c: Client, fn: string, ...args: unknown[]) =>
  (
    await c.query(
      `SELECT public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) AS r`,
      args.map((a) => (typeof a === 'object' && a !== null ? JSON.stringify(a) : a)),
    )
  ).rows[0].r as Json;
const append = (c: Client, receipt: unknown) => call(c, 'agentic_explain_receipt_append', receipt);
const read = (c: Client, run: string) => call(c, 'agentic_explain_receipt_read', run);
const purge = (c: Client) => call(c, 'agentic_explain_receipt_purge');

const released = (tenant: string, actor: string, run: string): Json => ({
  schemaVersion: 'agentic.explain-outcome.v2',
  evidenceKind: 'harness-run',
  runId: run,
  tenantId: tenant,
  requesterRef: actor,
  task: 'pgx.explain.v1',
  terminalState: 'released',
  reasonCode: 'RELEASED',
  detailCodes: [],
  harnessVersion: SHA('a'),
  model: { modelId: 'scripted-v1', invocationPath: 'scripted', sdkVersion: 'none' },
  digests: { template: SHA('b'), evidence: HMAC('c'), output: HMAC('d') },
  guardsRun: ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'VERIFIER'],
  counters: { slots: 2, modelCalls: 2, inputUnits: 1200, generatedUnits: 128, usageState: 'known' },
});
const held = (tenant: string, actor: string, run: string): Json => ({
  ...released(tenant, actor, run),
  terminalState: 'held',
  reasonCode: 'SENSOR_HOLD',
  detailCodes: ['S3_TERM_NOT_ALLOWED', 'S6_QUALIFIER_DROPPED'],
  digests: { template: SHA('b'), evidence: HMAC('c'), output: HMAC('e') },
  guardsRun: ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'],
});
const noCall = (tenant: string, actor: string, run: string): Json => ({
  ...held(tenant, actor, run),
  reasonCode: 'NOT_ELIGIBLE',
  detailCodes: ['cell-disputed'],
  model: null,
  digests: { template: null, evidence: HMAC('c'), output: null },
  guardsRun: [],
  counters: { slots: 0, modelCalls: 0, inputUnits: 0, generatedUnits: 0, usageState: 'known' },
});
const count = (tenant: string) =>
  owner(async (c) => (await c.query('SELECT count(*)::int AS n FROM public.agentic_explain_receipts WHERE tenant_id = $1', [tenant])).rows[0].n as number);

let capA: () => Promise<string>;
let capB: () => Promise<string>;
beforeAll(async () => {
  db = await createEphemeralDatabase();
  await member(TENANT_A, ACTOR_A);
  await member(TENANT_B, ACTOR_B);
  capA = () => mint(TENANT_A, ACTOR_A);
  capB = () => mint(TENANT_B, ACTOR_B);
});
afterAll(async () => {
  await db?.drop();
});

describe('append and read: a receipt round-trips exactly, and only for its own caller', () => {
  it('stores a release, a hold and a run that never reached a model, and reads each back identical', async () => {
    const cap = await capA();
    for (const [i, make] of [released, held, noCall].entries()) {
      const receipt = make(TENANT_A, ACTOR_A, `run-rt-${i}`);
      const out = await as(db.appUrl, cap, (c) => append(c, receipt));
      expect(out).toMatchObject({ kind: 'ok' });
      expect(await as(db.appUrl, await capA(), (c) => read(c, `run-rt-${i}`))).toEqual({ kind: 'ok', value: receipt });
    }
  });
  it('the worker login can append too (it is granted the same functions)', async () => {
    const out = await as(db.workerUrl, await capA(), (c) => append(c, released(TENANT_A, ACTOR_A, 'run-worker')));
    expect(out).toMatchObject({ kind: 'ok' });
  });
  it('refusals before admission share the run id "unadmitted" and are all kept; a real run id is stored once', async () => {
    const cap = await capA();
    const base = noCall(TENANT_A, ACTOR_A, 'unadmitted');
    for (let i = 0; i < 2; i++) expect(await as(db.appUrl, cap, (c) => append(c, base))).toMatchObject({ kind: 'ok' });
    expect(await as(db.appUrl, cap, (c) => append(c, released(TENANT_A, ACTOR_A, 'run-once')))).toMatchObject({ kind: 'ok' });
    expect(await as(db.appUrl, cap, (c) => append(c, released(TENANT_A, ACTOR_A, 'run-once')))).toEqual({ kind: 'refused', code: 'DUPLICATE' });
    expect(await as(db.appUrl, cap, (c) => read(c, 'unadmitted'))).toEqual({ kind: 'refused', code: 'INVALID_INPUT' });
  });
  it('reading a run that has no receipt returns null, not a refusal', async () =>
    expect(await as(db.appUrl, await capA(), (c) => read(c, 'run-none'))).toEqual({ kind: 'ok', value: null }));

  it('another organization cannot read, and cannot append in the name of the first', async () => {
    await as(db.appUrl, await capA(), (c) => append(c, released(TENANT_A, ACTOR_A, 'run-private')));
    expect(await as(db.appUrl, await capB(), (c) => read(c, 'run-private'))).toEqual({ kind: 'ok', value: null });
    const before = await count(TENANT_A);
    expect(await as(db.appUrl, await capB(), (c) => append(c, released(TENANT_A, ACTOR_A, 'run-forged')))).toEqual({ kind: 'refused', code: 'NOT_AUTHORIZED' });
    expect(await as(db.appUrl, await capA(), (c) => append(c, released(TENANT_A, ACTOR_B, 'run-forged-actor')))).toEqual({ kind: 'refused', code: 'NOT_AUTHORIZED' });
    expect(await count(TENANT_A)).toBe(before);
    // Control: the same caller appending its own receipt succeeds.
    expect(await as(db.appUrl, await capB(), (c) => append(c, released(TENANT_B, ACTOR_B, 'run-b')))).toMatchObject({ kind: 'ok' });
  });
  it('a caller with no capability is refused by every function, even naming the organization in a setting', async () => {
    const before = await count(TENANT_A);
    const out = await as(db.appUrl, undefined, async (c) => {
      await c.query(`SELECT set_config('app.current_tenant_id', $1, true), set_config('app.current_actor', $2, true)`, [TENANT_A, ACTOR_A]);
      return [await append(c, released(TENANT_A, ACTOR_A, 'run-nocap')), await read(c, 'run-once'), await purge(c)];
    });
    for (const r of out) expect(r).toEqual({ kind: 'refused', code: 'NOT_AUTHORIZED' });
    expect(await count(TENANT_A)).toBe(before);
  });
});

describe('a receipt cannot carry text: every hostile shape is refused and leaves the table as it was', () => {
  const bad: Array<[string, (r: Json) => Json]> = [
    ['an extra top-level key holding text', (r) => ({ ...r, explanation: 'Reduced enzyme function increases exposure to drugv.' })],
    ['an extra key inside digests', (r) => ({ ...r, digests: { ...(r.digests as Json), note: 'free text' } })],
    ['an extra key inside counters', (r) => ({ ...r, counters: { ...(r.counters as Json), note: 1 } })],
    ['an extra key inside the model', (r) => ({ ...r, model: { ...(r.model as Json), note: 'x' } })],
    ['a missing key', (r) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'guardsRun'))],
    ['a plain sha256 as the evidence digest', (r) => ({ ...r, digests: { ...(r.digests as Json), evidence: SHA('c') } })],
    ['a plain sha256 as the output digest', (r) => ({ ...r, digests: { ...(r.digests as Json), output: SHA('d') } })],
    ['a model alias', (r) => ({ ...r, model: { ...(r.model as Json), modelId: 'latest' } })],
    [
      'a sentence as a detail code',
      (r) => ({
        ...r,
        terminalState: 'held',
        reasonCode: 'SENSOR_HOLD',
        detailCodes: ['the phenotype was Synthetic Poor'],
        digests: { ...(r.digests as Json), output: HMAC('e') },
      }),
    ],
    ['a sentence as the run id', (r) => ({ ...r, runId: 'a run with a long name' })],
    ['a reason code that is not in the list', (r) => ({ ...r, terminalState: 'held', reasonCode: 'MADE_UP' })],
    ['a release with the held reason', (r) => ({ ...r, reasonCode: 'SENSOR_HOLD' })],
    ['a release with no output digest', (r) => ({ ...r, digests: { ...(r.digests as Json), output: null } })],
    ['a release with unknown usage', (r) => ({ ...r, counters: { ...(r.counters as Json), usageState: 'unknown' } })],
    ['a model for a run that made no call', (r) => ({ ...r, counters: { ...(r.counters as Json), modelCalls: 0 } })],
    ['a fifth slot', (r) => ({ ...r, counters: { ...(r.counters as Json), slots: 5 } })],
    ['a negative unit count', (r) => ({ ...r, counters: { ...(r.counters as Json), inputUnits: -1 } })],
    ['a fractional unit count', (r) => ({ ...r, counters: { ...(r.counters as Json), inputUnits: 1.5 } })],
    ['a unit count as a string', (r) => ({ ...r, counters: { ...(r.counters as Json), inputUnits: '12' } })],
    ['a guard that does not exist', (r) => ({ ...r, guardsRun: ['S1', 'S9'] })],
    ['a detail code that is a number', (r) => ({ ...r, detailCodes: [7] })],
    ['the wrong task', (r) => ({ ...r, task: 'other.task.v1' })],
    ['the wrong schema version', (r) => ({ ...r, schemaVersion: 'synthetic.business-outcome.v1' })],
    ['an array instead of an object', () => [] as unknown as Json],
  ];
  it.each(bad)('refuses %s', async (_name, make) => {
    const cap = await capA();
    const before = await count(TENANT_A);
    const out = await as(db.appUrl, cap, (c) => append(c, make(released(TENANT_A, ACTOR_A, `run-bad-${randomUUID().slice(0, 8)}`))));
    expect(out).toMatchObject({ kind: 'refused' });
    expect(['INVALID_INPUT', 'NOT_AUTHORIZED']).toContain(out.code);
    expect(await count(TENANT_A)).toBe(before);
  });
  it('the table itself, written to directly by its owner, also refuses a plain digest, an alias and a sentence (the checks are not only in the function)', async () => {
    const cols = `tenant_id, run_id, requester_ref, task, terminal_state, reason_code, harness_version, evidence_digest, slots, model_calls, input_units, generated_units, usage_state`;
    const row = (patch: Record<string, string>) => {
      const base: Record<string, string> = {
        tenant_id: `'${TENANT_A}'`,
        run_id: `'run-direct-${randomUUID().slice(0, 8)}'`,
        requester_ref: `'${ACTOR_A}'`,
        task: `'pgx.explain.v1'`,
        terminal_state: `'held'`,
        reason_code: `'NOT_ELIGIBLE'`,
        harness_version: `'${SHA('a')}'`,
        evidence_digest: `'${HMAC('c')}'`,
        slots: '0',
        model_calls: '0',
        input_units: '0',
        generated_units: '0',
        usage_state: `'known'`,
      };
      return `INSERT INTO public.agentic_explain_receipts (${cols}) VALUES (${cols
        .split(', ')
        .map((k) => patch[k] ?? base[k])
        .join(', ')})`;
    };
    await owner(async (c) => {
      expect((await c.query(row({}))).rowCount).toBe(1); // control
      await expect(c.query(row({ evidence_digest: `'${SHA('c')}'` }))).rejects.toMatchObject({ code: '23514' });
      await expect(c.query(row({ run_id: `'the phenotype was Synthetic Poor'` }))).rejects.toMatchObject({ code: '23514' });
      await expect(c.query(row({ reason_code: `'free text reason'` }))).rejects.toMatchObject({ code: '23514' });
    });
  });
});

describe('no login can touch the table, and nobody can change a receipt', () => {
  it('the application and the worker have no table privilege (control: the function works for them)', async () => {
    for (const url of [db.appUrl, db.workerUrl]) {
      for (const sql of [
        'SELECT 1 FROM public.agentic_explain_receipts',
        `DELETE FROM public.agentic_explain_receipts`,
        `UPDATE public.agentic_explain_receipts SET slots = 0`,
        `TRUNCATE public.agentic_explain_receipts`,
      ]) {
        await expect(as(url, undefined, (c) => c.query(sql))).rejects.toMatchObject({ code: '42501' });
      }
    }
    expect(await as(db.appUrl, await capA(), (c) => read(c, 'run-once'))).toMatchObject({ kind: 'ok' });
  });
  it('the owner, a role with no superuser, cannot update a receipt, truncate, or delete a young one; a superuser cannot either', async () => {
    await as(db.appUrl, await capA(), (c) => append(c, released(TENANT_A, ACTOR_A, 'run-frozen')));
    for (const asRole of [true, false]) {
      await owner(async (c) => {
        await c.query('BEGIN');
        if (asRole) await c.query('SET LOCAL ROLE telesphoros_jobs');
        else expect((await c.query('SELECT rolsuper FROM pg_roles WHERE rolname = current_user')).rows[0].rolsuper).toBe(true);
        const seen = (await c.query(`SELECT count(*)::int AS n FROM public.agentic_explain_receipts WHERE run_id = 'run-frozen'`)).rows[0].n;
        expect(seen).toBe(1); // the premise: this role sees the row, so a refusal is the guard's and not row security's
        await c.query('SAVEPOINT s1');
        await expect(c.query(`UPDATE public.agentic_explain_receipts SET slots = 1 WHERE run_id = 'run-frozen'`)).rejects.toMatchObject({ code: '23000' });
        await c.query('ROLLBACK TO s1');
        await expect(c.query(`DELETE FROM public.agentic_explain_receipts WHERE run_id = 'run-frozen'`)).rejects.toMatchObject({ code: '23000' });
        await c.query('ROLLBACK TO s1');
        await expect(c.query('TRUNCATE public.agentic_explain_receipts')).rejects.toMatchObject({ code: '23000' });
        await c.query('ROLLBACK');
      });
    }
  });
});

describe('retention: six years, enforced by the row, for the bound organization only', () => {
  const daysAgo = (n: number) => `clock_timestamp() - interval '${n} days'`;
  const seed = (tenant: string, actor: string, run: string, age: number) =>
    owner((c) =>
      c.query(
        `INSERT INTO public.agentic_explain_receipts (tenant_id, run_id, requester_ref, task, terminal_state, reason_code, harness_version, evidence_digest, slots, model_calls, input_units, generated_units, usage_state, created_at)
         VALUES ($1, $2, $3, 'pgx.explain.v1', 'held', 'NOT_ELIGIBLE', $4, $5, 0, 0, 0, 0, 'known', ${daysAgo(age)})`,
        [tenant, run, actor, SHA('a'), HMAC('c')],
      ),
    );
  const present = (run: string) => owner(async (c) => (await c.query('SELECT 1 FROM public.agentic_explain_receipts WHERE run_id = $1', [run])).rowCount === 1);

  it("purge removes the bound organization's receipts older than 2190 days, keeps younger ones and other organizations' rows", async () => {
    await seed(TENANT_A, ACTOR_A, 'ret-a-old-1', 2191);
    await seed(TENANT_A, ACTOR_A, 'ret-a-old-2', 4000);
    await seed(TENANT_A, ACTOR_A, 'ret-a-edge', 2189);
    await seed(TENANT_A, ACTOR_A, 'ret-a-new', 1);
    await seed(TENANT_B, ACTOR_B, 'ret-b-old', 3000);
    expect(await as(db.appUrl, await capA(), (c) => purge(c))).toEqual({ kind: 'ok', value: { deleted: 2 } });
    expect(await present('ret-a-old-1')).toBe(false);
    expect(await present('ret-a-old-2')).toBe(false);
    expect(await present('ret-a-edge')).toBe(true);
    expect(await present('ret-a-new')).toBe(true);
    expect(await present('ret-b-old')).toBe(true); // another organization's expired row is not this caller's to purge
    expect(await as(db.appUrl, await capB(), (c) => purge(c))).toEqual({ kind: 'ok', value: { deleted: 1 } });
    expect(await present('ret-b-old')).toBe(false);
    expect(await as(db.appUrl, await capA(), (c) => purge(c))).toEqual({ kind: 'ok', value: { deleted: 0 } }); // control: nothing left to purge
  });
  it("the age floor is the row's own: the owner may delete an expired row and may not delete one a day short of it", async () => {
    await seed(TENANT_A, ACTOR_A, 'floor-old', 2191);
    await seed(TENANT_A, ACTOR_A, 'floor-young', 2189);
    await owner(async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE telesphoros_jobs');
      await c.query('SAVEPOINT s1');
      await expect(c.query(`DELETE FROM public.agentic_explain_receipts WHERE run_id = 'floor-young'`)).rejects.toMatchObject({ code: '23000' });
      await c.query('ROLLBACK TO s1');
      expect((await c.query(`DELETE FROM public.agentic_explain_receipts WHERE run_id = 'floor-old'`)).rowCount).toBe(1);
      await c.query('ROLLBACK');
    });
  });
});

describe('what the table can hold (R5, FR-014)', () => {
  const factsOn = async (c: Client) => ({
    columns: (
      await c.query(
        `SELECT a.attnum, a.attname, format_type(a.atttypid, a.atttypmod) AS type FROM pg_attribute a WHERE a.attrelid = 'public.agentic_explain_receipts'::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY 1`,
      )
    ).rows as Array<{ attnum: number; attname: string; type: string }>,
    checks: (await c.query(`SELECT pg_get_constraintdef(oid) AS def, conkey FROM pg_constraint WHERE conrelid = 'public.agentic_explain_receipts'::regclass AND contype = 'c'`))
      .rows as Array<{ def: string; conkey: number[] }>,
  });
  const facts = () => owner(factsOn);
  /** Every text column is bound by a check that names a pattern, a list or a fixed value; no column is json, bytea or an array. */
  const unboundTextColumns = (f: Awaited<ReturnType<typeof facts>>) =>
    f.columns
      .filter((col) => col.type === 'text' && !f.checks.some((chk) => chk.conkey.length === 1 && chk.conkey[0] === col.attnum && /~|ANY \(ARRAY|= '/.test(chk.def)))
      .map((col) => col.attname);
  it('has no json, bytea or array column, and every text column is bound to a pattern, a list or a fixed value', async () => {
    const f = await facts();
    expect(f.columns.map((c) => c.type).filter((t) => !['uuid', 'text', 'integer', 'bigint', 'timestamp with time zone'].includes(t))).toEqual([]);
    expect(unboundTextColumns(f)).toEqual([]);
  });
  it('control: the same test would catch a text column with no check', async () => {
    await owner(async (c) => {
      await c.query('BEGIN');
      await c.query('ALTER TABLE public.agentic_explain_receipts ADD COLUMN note text');
      expect(unboundTextColumns(await factsOn(c))).toEqual(['note']); // same connection: another one would wait on the table lock
      await c.query('ROLLBACK');
    });
    expect(unboundTextColumns(await facts())).toEqual([]);
  });
  it('lists the same reason codes as the TypeScript failure reasons plus RELEASED', async () => {
    const f = await facts();
    const def = f.checks.find((chk) => chk.def.includes('ANY (ARRAY') && chk.def.includes('reason_code'))!.def;
    const inDb = [...def.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]).sort();
    expect(inDb).toEqual(
      [
        'RELEASED',
        'INVALID_INPUT',
        'TASK_UNDECLARED',
        'NOT_SYNTHETIC',
        'NO_BAA',
        'AUTHORITY_HELD',
        'IDEMPOTENCY_CONFLICT',
        'IN_PROGRESS',
        'IDEMPOTENT_REPLAY',
        'BUDGET_HELD',
        'NOT_ELIGIBLE',
        'INPUT_REFUSED',
        'USAGE_HELD',
        'MODEL_ERROR',
        'MODEL_REFUSED',
        'INVALID_STRUCTURE',
        'SENSOR_HOLD',
        'VERIFIER_HOLD',
        'DEADLINE',
        'CONTROL_HELD',
      ].sort(),
    );
  });
});

describe('ownership and privileges', () => {
  it('the table and the functions are owned by telesphoros_jobs, row security is forced, the functions are definers with a fixed search_path, and only app and worker may run them', async () => {
    await owner(async (c) => {
      const t = (
        await c.query(
          `SELECT pg_get_userbyid(relowner) AS owner, relrowsecurity, relforcerowsecurity, relacl::text AS acl FROM pg_class WHERE oid = 'public.agentic_explain_receipts'::regclass`,
        )
      ).rows[0];
      expect(t).toMatchObject({ owner: 'telesphoros_jobs', relrowsecurity: true, relforcerowsecurity: true });
      expect(t.acl ?? '').not.toMatch(/telesphoros_(app|worker|verifier|issuer)/);
      const fns = (
        await c.query(
          `SELECT p.proname, pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.proconfig::text AS config,
                  has_function_privilege('telesphoros_app', p.oid, 'EXECUTE') AS app, has_function_privilege('telesphoros_worker', p.oid, 'EXECUTE') AS worker,
                  has_function_privilege('public', p.oid, 'EXECUTE') AS pub
           FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('agentic_explain_receipt_append', 'agentic_explain_receipt_read', 'agentic_explain_receipt_purge') ORDER BY 1`,
        )
      ).rows;
      expect(fns.map((f) => f.proname)).toEqual(['agentic_explain_receipt_append', 'agentic_explain_receipt_purge', 'agentic_explain_receipt_read']);
      for (const f of fns) expect(f).toMatchObject({ owner: 'telesphoros_jobs', prosecdef: true, app: true, worker: true, pub: false });
      for (const f of fns) expect(f.config).toMatch(/search_path=pg_catalog, pg_temp/);
      const schemaCreate = (await c.query(`SELECT has_schema_privilege('telesphoros_jobs', 'public', 'CREATE') AS can`)).rows[0].can;
      expect(schemaCreate).toBe(false); // the migration gave CREATE only while it ran
    });
  });
});

describe('the down migration', () => {
  it('drops the table and the functions when the table is empty, and applies again', async () => {
    const fresh = await createEphemeralDatabase();
    try {
      const undo = revertThrough('agentic_explain_receipts');
      await withAdmin(fresh.adminUrl, async (c) => expect(await migrateDown(c, undo.steps)).toEqual(undo.reverted));
      const left = await withAdmin(fresh.adminUrl, async (c) => ({
        table: (await c.query(`SELECT to_regclass('public.agentic_explain_receipts') AS t`)).rows[0].t,
        fns: (await c.query(`SELECT proname FROM pg_proc WHERE proname LIKE 'agentic_explain_receipt%'`)).rowCount,
      }));
      expect(left).toEqual({ table: null, fns: 0 });
    } finally {
      await fresh.drop();
    }
  });
  it('refuses to drop a populated table unless the exact setting is given, and the refusal rolls back whole', async () => {
    const fresh = await createEphemeralDatabase();
    try {
      await withAdmin(fresh.adminUrl, (c) =>
        c.query(
          `INSERT INTO public.agentic_explain_receipts (tenant_id, run_id, requester_ref, task, terminal_state, reason_code, harness_version, evidence_digest, slots, model_calls, input_units, generated_units, usage_state)
           VALUES ('rcpt-down', 'run-down', 'x', 'pgx.explain.v1', 'held', 'NOT_ELIGIBLE', $1, $2, 0, 0, 0, 0, 'known')`,
          [SHA('a'), HMAC('c')],
        ),
      );
      const undo = revertThrough('agentic_explain_receipts');
      await withAdmin(fresh.adminUrl, async (c) => {
        await expect(migrateDown(c, undo.steps)).rejects.toThrow(/Refusing to drop agentic_explain_receipts/);
        expect((await c.query(`SELECT to_regclass('public.agentic_explain_receipts') AS t`)).rows[0].t).not.toBeNull();
        await c.query(`SET telesphoros.allow_receipts_drop = 'Yes'`);
        await expect(migrateDown(c, undo.steps)).rejects.toThrow(/Refusing to drop agentic_explain_receipts/);
        await c.query(`SET telesphoros.allow_receipts_drop = 'yes'`);
        expect(await migrateDown(c, undo.steps)).toEqual(undo.reverted);
      });
    } finally {
      await fresh.drop();
    }
  });
});
