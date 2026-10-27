import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { migrateDown } from '../../src/db/migrator';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';
import { registerTenantRow } from '../helpers/membership';
import { revertAbove, revertThrough } from '../helpers/migration-history';

/**
 * Migration 0049 (LLM harness 3b-2a): the durable run of an explanation. Every hostile case sits next to a positive control that succeeds in the same state; the immutability
 * cases run as the NOLOGIN owner (no superuser) and again as a superuser; concurrency is real (separate connections, one transaction each). Data is synthetic.
 */
jest.setTimeout(180_000);

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the JSON a database function returns, read field by field in the assertions below
type Json = Record<string, any>;
let db: EphemeralDatabase;
const owner = <T>(work: (c: Client) => Promise<T>) => withAdmin(db.adminUrl, work);
/**
 * Back-dated and part-way rows are what only a tamperer could write, so the row guard refuses to let anyone insert them. The tests that need such a row (time passing is
 * not something a test can wait for) switch the guard off inside one transaction, plant the row, and switch it back to ENABLE ALWAYS before committing.
 */
const planting = <T>(work: (c: Client) => Promise<T>): Promise<T> =>
  owner(async (c) => {
    await c.query('BEGIN');
    try {
      await c.query('ALTER TABLE public.agentic_explain_runs DISABLE TRIGGER agentic_explain_run_guard');
      const result = await work(c);
      await c.query('ALTER TABLE public.agentic_explain_runs ENABLE ALWAYS TRIGGER agentic_explain_run_guard');
      await c.query('COMMIT');
      return result;
    } catch (error) {
      await c.query('ROLLBACK');
      throw error;
    }
  });
const sha = (label: string) => `sha256:${createHash('sha256').update(label).digest('hex')}`;
const HMAC = (ch: string) => `hmac-sha256:${ch.repeat(64)}`;
const hashOf = (value: string) => createHash('sha256').update(value, 'utf8').digest();
const token = () => randomBytes(32).toString('base64url');

const TENANT_A = 'run-a';
const TENANT_B = 'run-b';
const ALICE = 'run-a-alice';
const ALICIA = 'run-a-alicia';
const BOB = 'run-b-bob';
const TERMINAL = ['released', 'held', 'failed', 'cancelled', 'expired'];
const STATES = ['admitted', 'queued', 'running', 'reviewing', 'repair-pending', 'release-pending', ...TERMINAL];

async function member(tenant: string, sub: string): Promise<void> {
  await owner(async (c) => {
    await registerTenantRow(c, tenant);
    await c.query(`INSERT INTO tenant_memberships (tenant_id, sub, status, roles, changed_by) VALUES ($1, $2, 'active', ARRAY['reader'], 'test') ON CONFLICT DO NOTHING`, [
      tenant,
      sub,
    ]);
  });
}
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
const fn = async (c: Client, sql: string, args: unknown[]) => (await c.query(`SELECT ${sql} AS r`, args)).rows[0].r as Json;
const admit = (c: Client, key: string, tuple = HMAC('c'), harness = sha('h'), mono: number | null = 5) =>
  fn(c, 'public.agentic_explain_run_admit($1::text, $2::text, $3::text, $4::bigint)', [sha(key), tuple, harness, mono]);
const get = (c: Client, id: string) => fn(c, 'public.agentic_explain_run_get($1::uuid)', [id]);
const advance = (c: Client, id: string, expected: unknown, next: string) =>
  fn(c, 'public.agentic_explain_run_advance($1::uuid, $2::jsonb, $3::text)', [id, JSON.stringify(expected), next]);
const cancel = (c: Client, id: string) => fn(c, 'public.agentic_explain_run_cancel($1::uuid)', [id]);
const expectOf = (run: Json) => ({ state: run.state, sequence: run.sequence, fence: run.fence });

/** One organization's application session: a fresh capability per call, committed. */
const sess =
  (tenant: string, sub: string) =>
  async <T>(work: (c: Client) => Promise<T>) =>
    as(db.appUrl, await mint(tenant, sub), work);
let alice: ReturnType<typeof sess>;
let alicia: ReturnType<typeof sess>;
let bob: ReturnType<typeof sess>;

const count = (tenant: string) =>
  owner(async (c) => (await c.query('SELECT count(*)::int AS n FROM public.agentic_explain_runs WHERE tenant_id = $1', [tenant])).rows[0].n as number);
const newRun = async (who: ReturnType<typeof sess>, key: string): Promise<Json> => (await who((c) => admit(c, key))).value.run;
/** Inserts a run the way the owner can (the tests' stand-in for time passing): any state, any age. */
const seed = (tenant: string, requester: string, key: string, state: string, opts: { admittedDaysAgo?: number; finishedDaysAgo?: number; deadlineIn?: string } = {}) =>
  planting(async (c) => {
    const finished = TERMINAL.includes(state);
    const admitted = opts.admittedDaysAgo ?? 0;
    const finishedAgo = opts.finishedDaysAgo ?? 0;
    return (
      await c.query(
        `INSERT INTO public.agentic_explain_runs (tenant_id, requester_ref, key_hash, tuple_digest, harness_version, state, mono_at, admitted_at, deadline_at, finished_at)
         VALUES ($1, $2, $3, $4, $5, $6, 1, clock_timestamp() - ($7 || ' days')::interval, clock_timestamp() - ($7 || ' days')::interval + ($8)::interval, ${finished ? "clock_timestamp() - ($9 || ' days')::interval" : 'NULL'})
         RETURNING run_id`,
        [tenant, requester, sha(key), HMAC('c'), sha('h'), state, String(admitted), opts.deadlineIn ?? '120 seconds', ...(finished ? [String(finishedAgo)] : [])],
      )
    ).rows[0].run_id as string;
  });

beforeAll(async () => {
  db = await createEphemeralDatabase();
  await member(TENANT_A, ALICE);
  await member(TENANT_A, ALICIA);
  await member(TENANT_B, BOB);
  alice = sess(TENANT_A, ALICE);
  alicia = sess(TENANT_A, ALICIA);
  bob = sess(TENANT_B, BOB);
});
afterAll(async () => {
  await db?.drop();
});

describe('admit: one run per key, found again on a retry, and seen only by its own requester', () => {
  it('admits a new run, finds it again for the same request, and reports a different request under the same key as a conflict', async () => {
    const first = await alice((c) => admit(c, 'k-basic'));
    expect(first).toMatchObject({
      kind: 'ok',
      value: { kind: 'new', run: { tenantId: TENANT_A, requesterRef: ALICE, state: 'admitted', sequence: 0, fence: 1, monoAt: 5, profileDigest: sha('h') } },
    });
    const run = first.value.run;
    expect(run.deadlineAt - run.admittedAt).toBeGreaterThanOrEqual(119_000);
    expect(run.deadlineAt - run.admittedAt).toBeLessThanOrEqual(121_000);
    expect(await alice((c) => admit(c, 'k-basic'))).toEqual({ kind: 'ok', value: { kind: 'existing', run } });
    expect(await alice((c) => admit(c, 'k-basic', HMAC('d')))).toEqual({ kind: 'ok', value: { kind: 'conflict', run } });
    expect(await alice((c) => get(c, run.id))).toEqual({ kind: 'ok', value: run });
  });
  it("another requester in the same organization, and another organization, get their own run for the same key, and cannot read or move each other's", async () => {
    const mine = await newRun(alice, 'k-iso');
    const sameOrg = await newRun(alicia, 'k-iso');
    const otherOrg = await newRun(bob, 'k-iso');
    expect(new Set([mine.id, sameOrg.id, otherOrg.id]).size).toBe(3);
    for (const who of [alicia, bob]) {
      expect(await who((c) => get(c, mine.id))).toEqual({ kind: 'ok', value: null });
      expect(await who((c) => advance(c, mine.id, expectOf(mine), 'queued'))).toEqual({ kind: 'refused', code: 'NOT_FOUND' });
      expect(await who((c) => cancel(c, mine.id))).toEqual({ kind: 'refused', code: 'NOT_FOUND' });
    }
    expect(await alice((c) => get(c, mine.id))).toMatchObject({ kind: 'ok', value: { state: 'admitted' } }); // control
  });
  const bad: Array<[string, (c: Client) => Promise<Json>]> = [
    ['a key hash that is not a sha256', (c) => fn(c, 'public.agentic_explain_run_admit($1::text, $2::text, $3::text, $4::bigint)', ['key-1', HMAC('c'), sha('h'), 1])],
    ['a plain sha256 as the request digest', (c) => fn(c, 'public.agentic_explain_run_admit($1::text, $2::text, $3::text, $4::bigint)', [sha('x'), sha('plain'), sha('h'), 1])],
    ['a harness version that is not a sha256', (c) => fn(c, 'public.agentic_explain_run_admit($1::text, $2::text, $3::text, $4::bigint)', [sha('x'), HMAC('c'), 'v1', 1])],
    ['a negative monotonic time', (c) => admit(c, 'x', HMAC('c'), sha('h'), -1)],
    ['a null monotonic time', (c) => admit(c, 'x', HMAC('c'), sha('h'), null)],
    ['a null key hash', (c) => fn(c, 'public.agentic_explain_run_admit(NULL::text, $1::text, $2::text, $3::bigint)', [HMAC('c'), sha('h'), 1])],
  ];
  it.each(bad)('refuses %s and stores nothing', async (_name, call) => {
    const before = await count(TENANT_A);
    expect(await alice(call)).toEqual({ kind: 'refused', code: 'INVALID_INPUT' });
    expect(await count(TENANT_A)).toBe(before);
  });
  it('a caller with no capability is refused by every function, even naming the organization in a setting; other logins cannot run them at all', async () => {
    const run = await newRun(alice, 'k-nocap');
    const out = await as(db.appUrl, undefined, async (c) => {
      await c.query(`SELECT set_config('app.current_tenant_id', $1, true), set_config('app.current_actor', $2, true)`, [TENANT_A, ALICE]);
      return [await admit(c, 'k-nocap-2'), await get(c, run.id), await advance(c, run.id, expectOf(run), 'queued'), await cancel(c, run.id)];
    });
    for (const r of out) expect(r).toEqual({ kind: 'refused', code: 'NOT_AUTHORIZED' });
    for (const url of [db.workerUrl, db.verifierUrl, db.issuerUrl]) {
      await expect(as(url, await mint(TENANT_A, ALICE), (c) => admit(c, 'k-other-login'))).rejects.toMatchObject({ code: '42501' });
    }
  });
  it('twenty concurrent admissions of the same key give exactly one new run and nineteen reports of it', async () => {
    const caps = await Promise.all(Array.from({ length: 20 }, () => mint(TENANT_A, ALICE)));
    const results = await Promise.all(caps.map((cap) => as(db.appUrl, cap, (c) => admit(c, 'k-race'))));
    expect(results.filter((r) => r.value.kind === 'new')).toHaveLength(1);
    expect(results.filter((r) => r.value.kind === 'existing')).toHaveLength(19);
    expect(new Set(results.map((r) => r.value.run.id)).size).toBe(1);
    expect(
      (await owner((c) => c.query(`SELECT count(*)::int AS n FROM public.agentic_explain_runs WHERE key_hash = $1 AND tenant_id = $2`, [sha('k-race'), TENANT_A]))).rows[0].n,
    ).toBe(1);
  });
  it('a run past its deadline that nobody finished is expired by the next admission of its key, and the retry sees a finished run', async () => {
    await seed(TENANT_A, ALICE, 'k-stale', 'running', { admittedDaysAgo: 1 });
    const out = await alice((c) => admit(c, 'k-stale'));
    expect(out).toMatchObject({ kind: 'ok', value: { kind: 'existing', run: { state: 'expired', sequence: 1 } } });
    expect((await owner((c) => c.query(`SELECT finished_at IS NOT NULL AS done FROM public.agentic_explain_runs WHERE key_hash = $1`, [sha('k-stale')]))).rows[0].done).toBe(true);
    // Control: a run still inside its deadline is left alone.
    await seed(TENANT_A, ALICE, 'k-fresh', 'running');
    expect(await alice((c) => admit(c, 'k-fresh'))).toMatchObject({ value: { kind: 'existing', run: { state: 'running', sequence: 0 } } });
  });
  it('an organization may admit at most 1000 runs an hour: the next new key is RATE_LIMITED, an existing key is still answered, older rows do not count, another organization is unaffected', async () => {
    const t = 'run-rate';
    await member(t, 'run-rate-ray');
    const who = sess(t, 'run-rate-ray');
    const fill = (age: string, label: string) =>
      planting((c) =>
        c.query(
          `INSERT INTO public.agentic_explain_runs (tenant_id, requester_ref, key_hash, tuple_digest, harness_version, state, mono_at, admitted_at, deadline_at, finished_at)
           SELECT $1, 'run-rate-ray', 'sha256:' || encode(sha256(($2 || g)::bytea), 'hex'), $3, $4, 'held', 1, clock_timestamp() - interval '${age}', clock_timestamp() - interval '${age}' + interval '120 seconds', clock_timestamp() - interval '${age}'
             FROM generate_series(1, 1000) g`,
          [t, label, HMAC('c'), sha('h')],
        ),
      );
    await fill('2 hours', 'old-');
    expect(await who((c) => admit(c, 'rate-first'))).toMatchObject({ value: { kind: 'new' } }); // 1000 old rows do not count
    await fill('5 minutes', 'new-');
    expect(await who((c) => admit(c, 'rate-second'))).toEqual({ kind: 'refused', code: 'RATE_LIMITED' });
    expect(await who((c) => admit(c, 'rate-first'))).toMatchObject({ value: { kind: 'existing' } }); // a retry is not a new run
    expect(await bob((c) => admit(c, 'rate-other-org'))).toMatchObject({ value: { kind: 'new' } });
  });
  it('a suspended organization is refused and reads again once reinstated (0047)', async () => {
    const t = 'run-susp';
    await member(t, 'run-susp-sam');
    const who = sess(t, 'run-susp-sam');
    const cap = await mint(t, 'run-susp-sam');
    const run = (await as(db.appUrl, cap, (c) => admit(c, 'k-susp'))).value.run; // control, while active
    await owner((c) => c.query(`UPDATE tenants SET status = 'suspended', changed_by = 'test-operator' WHERE id = $1`, [t]));
    try {
      expect(await as(db.appUrl, cap, (c) => admit(c, 'k-susp-2'))).toEqual({ kind: 'refused', code: 'NOT_AUTHORIZED' });
      expect(await as(db.appUrl, cap, (c) => get(c, run.id))).toEqual({ kind: 'refused', code: 'NOT_AUTHORIZED' });
    } finally {
      await owner((c) => c.query(`UPDATE tenants SET status = 'active', changed_by = 'test-operator' WHERE id = $1`, [t]));
    }
    expect(await who((c) => get(c, run.id))).toMatchObject({ kind: 'ok', value: { id: run.id } });
  });
});

describe('advance: a compare-and-swap on state, sequence and fence, along the legal moves only', () => {
  it('walks the whole chain to released, each step returning the next sequence, and freezes the run', async () => {
    let run = await newRun(alice, 'k-chain');
    for (const [i, next] of ['queued', 'running', 'reviewing', 'release-pending', 'released'].entries()) {
      const out = await alice((c) => advance(c, run.id, expectOf(run), next));
      expect(out).toMatchObject({ kind: 'ok', value: { state: next, sequence: i + 1, fence: 1 } });
      run = out.value;
    }
    expect((await owner((c) => c.query(`SELECT finished_at IS NOT NULL AS done FROM public.agentic_explain_runs WHERE run_id = $1`, [run.id]))).rows[0].done).toBe(true);
    for (const next of STATES) expect(await alice((c) => advance(c, run.id, expectOf(run), next))).toEqual({ kind: 'refused', code: 'INVALID_TRANSITION' }); // a final state moves nowhere
  });
  it('allows the repair loop (reviewing > repair-pending > running > reviewing) and every in-flight state moving to held or failed, but not to cancelled or expired through advance', async () => {
    let run = await newRun(alice, 'k-repair');
    for (const next of ['queued', 'running', 'reviewing', 'repair-pending', 'running', 'reviewing']) run = (await alice((c) => advance(c, run.id, expectOf(run), next))).value;
    expect(run).toMatchObject({ state: 'reviewing', sequence: 6 });
    let n = 0;
    for (const from of ['admitted', 'queued', 'running', 'reviewing', 'repair-pending', 'release-pending']) {
      for (const to of ['held', 'failed']) {
        const r = await seed(TENANT_A, ALICE, `k-exit-${n++}`, from);
        expect(await alice((c) => advance(c, r, { state: from, sequence: 0, fence: 1 }, to))).toMatchObject({ kind: 'ok', value: { state: to } });
      }
      // advance does not write what the other functions own: 'cancelled' (cancel raises the fence) and 'expired' (the deadline, not the caller, decides it).
      for (const to of ['cancelled', 'expired']) {
        const r = await seed(TENANT_A, ALICE, `k-exit-${n++}`, from);
        expect(await alice((c) => advance(c, r, { state: from, sequence: 0, fence: 1 }, to))).toEqual({ kind: 'refused', code: 'INVALID_TRANSITION' });
        expect(await alice((c) => get(c, r))).toMatchObject({ value: { state: from, sequence: 0 } });
      }
    }
  });
  it('of eight concurrent advances from the same state exactly one wins and seven are stale', async () => {
    const run = await newRun(alice, 'k-cas');
    const caps = await Promise.all(Array.from({ length: 8 }, () => mint(TENANT_A, ALICE)));
    const results = await Promise.all(caps.map((cap) => as(db.appUrl, cap, (c) => advance(c, run.id, expectOf(run), 'queued'))));
    expect(results.filter((r) => r.kind === 'ok')).toHaveLength(1);
    expect(results.filter((r) => r.kind === 'refused' && r.code === 'STALE')).toHaveLength(7);
    expect(await alice((c) => get(c, run.id))).toMatchObject({ value: { state: 'queued', sequence: 1 } });
  });
  it('a stale sequence, state or fence is STALE; an illegal move is INVALID_TRANSITION; a malformed expectation is INVALID_INPUT; nothing changes', async () => {
    const run = await newRun(alice, 'k-stale-cas');
    const ex = expectOf(run);
    const cases: Array<[string, unknown, string, string]> = [
      ['a stale sequence', { ...ex, sequence: 7 }, 'queued', 'STALE'],
      ['a stale state', { ...ex, state: 'queued' }, 'running', 'STALE'],
      ['a stale fence', { ...ex, fence: 2 }, 'queued', 'STALE'],
      ['an illegal move', ex, 'reviewing', 'INVALID_TRANSITION'],
      ['a move to released from the start', ex, 'released', 'INVALID_TRANSITION'],
      ['an unknown state', ex, 'bogus', 'INVALID_TRANSITION'],
      ['an extra key', { ...ex, note: 'x' }, 'queued', 'INVALID_INPUT'],
      ['a missing key', { state: 'admitted', sequence: 0 }, 'queued', 'INVALID_INPUT'],
      ['a string sequence', { ...ex, sequence: '0' }, 'queued', 'INVALID_INPUT'],
      ['a fractional sequence', { ...ex, sequence: 0.5 }, 'queued', 'INVALID_INPUT'],
      ['a state that is not text', { ...ex, state: 7 }, 'queued', 'INVALID_INPUT'],
      ['a next state with spaces', ex, 'queued now', 'INVALID_INPUT'],
    ];
    for (const [, expected, next, code] of cases) expect(await alice((c) => advance(c, run.id, expected, next))).toEqual({ kind: 'refused', code });
    expect(await alice((c) => get(c, run.id))).toEqual({ kind: 'ok', value: run });
    expect(await alice((c) => advance(c, run.id, ex, 'queued'))).toMatchObject({ kind: 'ok', value: { state: 'queued' } }); // control
  });
  it('the legal moves are exactly the 31 pairs of the TypeScript state machine, checked against an independent statement of the rule', async () => {
    const chain = new Set([
      'admitted>queued',
      'queued>running',
      'running>reviewing',
      'reviewing>repair-pending',
      'reviewing>release-pending',
      'repair-pending>running',
      'release-pending>released',
    ]);
    const open = STATES.filter((s) => !TERMINAL.includes(s));
    const legal = (from: string, to: string) => open.includes(from) && (chain.has(`${from}>${to}`) || ['held', 'failed', 'cancelled', 'expired'].includes(to));
    const rows = (await owner((c) => c.query(`SELECT f, t, public.agentic_explain_transition_ok(f, t) AS ok FROM unnest($1::text[]) f CROSS JOIN unnest($1::text[]) t`, [STATES])))
      .rows;
    expect(rows).toHaveLength(121);
    for (const r of rows) expect(r.ok).toBe(legal(r.f, r.t));
    expect(rows.filter((r) => r.ok)).toHaveLength(31);
  });
});

describe('cancel: raises the fence, so a worker still holding the old one is stale', () => {
  it('cancels an unfinished run, refuses a second cancellation, and makes the old expectation stale', async () => {
    const run = await newRun(alice, 'k-cancel');
    const running = (await alice((c) => advance(c, run.id, expectOf(run), 'queued'))).value;
    const out = await alice((c) => cancel(c, run.id));
    expect(out).toMatchObject({ kind: 'ok', value: { state: 'cancelled', fence: 2, sequence: running.sequence + 1 } });
    expect(await alice((c) => advance(c, run.id, expectOf(running), 'running'))).toEqual({ kind: 'refused', code: 'STALE' });
    expect(await alice((c) => cancel(c, run.id))).toEqual({ kind: 'refused', code: 'INVALID_TRANSITION' });
    expect(await alice((c) => cancel(c, randomUUID()))).toEqual({ kind: 'refused', code: 'NOT_FOUND' });
  });
});

describe('the row cannot be changed except by the legal step, and cannot be deleted before its time', () => {
  const asRole = async (superuser: boolean, work: (c: Client) => Promise<void>) =>
    owner(async (c) => {
      await c.query('BEGIN');
      if (!superuser) await c.query('SET LOCAL ROLE telesphoros_jobs');
      await work(c);
      await c.query('ROLLBACK');
    });
  const refuses = async (c: Client, sql: string, args: unknown[] = [], message?: RegExp) => {
    await c.query('SAVEPOINT s');
    await expect(c.query(sql, args)).rejects.toMatchObject(message ? { code: '23000', message: expect.stringMatching(message) } : { code: '23000' });
    await c.query('ROLLBACK TO s');
  };
  it.each([
    ['a role with no superuser', false],
    ['a superuser', true],
  ])('as %s: a finished run is frozen, identity and ordering are fixed, young rows cannot be deleted, TRUNCATE is refused', async (_name, superuser) => {
    const open = await seed(TENANT_A, ALICE, `k-frozen-open-${superuser}`, 'running');
    const done = await seed(TENANT_A, ALICE, `k-frozen-done-${superuser}`, 'held');
    await asRole(superuser, async (c) => {
      expect((await c.query('SELECT count(*)::int AS n FROM public.agentic_explain_runs WHERE run_id IN ($1, $2)', [open, done])).rows[0].n).toBe(2); // the premise: this role sees the rows
      await refuses(c, `UPDATE public.agentic_explain_runs SET state = 'released' WHERE run_id = $1`, [done], /finished explanation run is immutable/); // the freeze itself, not only the move rule
      await refuses(c, `UPDATE public.agentic_explain_runs SET tenant_id = 'other' WHERE run_id = $1`, [open]);
      await refuses(c, `UPDATE public.agentic_explain_runs SET tuple_digest = $2 WHERE run_id = $1`, [open, HMAC('e')]);
      await refuses(c, `UPDATE public.agentic_explain_runs SET deadline_at = deadline_at + interval '1 day' WHERE run_id = $1`, [open]);
      await refuses(c, `UPDATE public.agentic_explain_runs SET state = 'queued', sequence = sequence + 1 WHERE run_id = $1`, [open]); // running > queued is not a legal move
      await refuses(c, `UPDATE public.agentic_explain_runs SET state = 'reviewing', sequence = sequence + 2 WHERE run_id = $1`, [open]); // sequence must rise by one
      await refuses(c, `UPDATE public.agentic_explain_runs SET fence = fence + 1 WHERE run_id = $1`, [open]); // the fence rises only with a cancellation
      await refuses(c, `DELETE FROM public.agentic_explain_runs WHERE run_id = $1`, [done]);
      await refuses(c, `DELETE FROM public.agentic_explain_runs WHERE run_id = $1`, [open]);
      await refuses(c, 'TRUNCATE public.agentic_explain_runs');
    });
  });
  it('the legal step is allowed to the owner (control), a cancellation may raise the fence by one, and both triggers are ENABLE ALWAYS and hold under session_replication_role = replica', async () => {
    const r = await seed(TENANT_A, ALICE, 'k-frozen-ctl', 'running');
    await owner(async (c) => {
      expect((await c.query(`SELECT tgname, tgenabled FROM pg_trigger WHERE tgrelid = 'public.agentic_explain_runs'::regclass AND NOT tgisinternal ORDER BY 1`)).rows).toEqual([
        { tgname: 'agentic_explain_run_guard', tgenabled: 'A' },
        { tgname: 'agentic_explain_run_no_truncate', tgenabled: 'A' },
      ]);
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE telesphoros_jobs');
      expect((await c.query(`UPDATE public.agentic_explain_runs SET state = 'reviewing', sequence = sequence + 1 WHERE run_id = $1`, [r])).rowCount).toBe(1);
      await c.query('ROLLBACK');
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE telesphoros_jobs');
      expect(
        (
          await c.query(
            `UPDATE public.agentic_explain_runs SET state = 'cancelled', sequence = sequence + 1, fence = fence + 1, finished_at = clock_timestamp() WHERE run_id = $1`,
            [r],
          )
        ).rowCount,
      ).toBe(1);
      await c.query('ROLLBACK');
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await refuses(c, `UPDATE public.agentic_explain_runs SET state = 'queued', sequence = sequence + 1 WHERE run_id = $1`, [r]);
      await refuses(c, 'TRUNCATE public.agentic_explain_runs');
      await c.query('ROLLBACK');
    });
  });
  it('a finished run may be deleted once it is 2190 days old, never an unfinished one however old, and never one a day short', async () => {
    const old = await seed(TENANT_A, ALICE, 'k-del-old', 'held', { admittedDaysAgo: 2300, finishedDaysAgo: 2191 });
    const young = await seed(TENANT_A, ALICE, 'k-del-young', 'held', { admittedDaysAgo: 2300, finishedDaysAgo: 2189 });
    const stuck = await seed(TENANT_A, ALICE, 'k-del-stuck', 'running', { admittedDaysAgo: 3000 });
    await asRole(false, async (c) => {
      await refuses(c, 'DELETE FROM public.agentic_explain_runs WHERE run_id = $1', [young]);
      await refuses(c, 'DELETE FROM public.agentic_explain_runs WHERE run_id = $1', [stuck]);
      expect((await c.query('DELETE FROM public.agentic_explain_runs WHERE run_id = $1', [old])).rowCount).toBe(1);
    });
  });
});

describe('operator functions: sweep and purge are run by the owner, never by a login, and reach every organization', () => {
  const operator = (sql: string, args: unknown[] = []) =>
    owner(async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE telesphoros_jobs');
      const r = (await c.query(`SELECT ${sql} AS r`, args)).rows[0].r as Json;
      await c.query('COMMIT');
      return r;
    });
  it('sweep expires every unfinished run past its deadline, in every organization (a suspended one too), and leaves finished runs and runs still inside their deadline', async () => {
    const t = 'run-sweep';
    await member(t, 'run-sweep-sue');
    const lateA = await seed(TENANT_A, ALICE, 'sw-late-a', 'running', { admittedDaysAgo: 1 });
    const lateS = await seed(t, 'run-sweep-sue', 'sw-late-s', 'queued', { admittedDaysAgo: 1 });
    const fresh = await seed(TENANT_A, ALICE, 'sw-fresh', 'running');
    const done = await seed(TENANT_A, ALICE, 'sw-done', 'held', { admittedDaysAgo: 1 });
    await owner((c) => c.query(`UPDATE tenants SET status = 'suspended', changed_by = 'test-operator' WHERE id = $1`, [t]));
    try {
      const out = await operator('public.agentic_explain_run_sweep()');
      expect(out.value.expired).toBeGreaterThanOrEqual(2);
      const states = Object.fromEntries(
        (await owner((c) => c.query('SELECT run_id, state FROM public.agentic_explain_runs WHERE run_id = ANY($1::uuid[])', [[lateA, lateS, fresh, done]]))).rows.map((r) => [
          r.run_id,
          r.state,
        ]),
      );
      expect(states).toEqual({ [lateA]: 'expired', [lateS]: 'expired', [fresh]: 'running', [done]: 'held' });
      expect(await operator('public.agentic_explain_run_sweep()')).toEqual({ kind: 'ok', value: { expired: 0 } }); // control: nothing left to sweep
    } finally {
      await owner((c) => c.query(`UPDATE tenants SET status = 'active', changed_by = 'test-operator' WHERE id = $1`, [t]));
    }
  });
  it('purge deletes finished runs older than 2190 days for the named organization or for all, and nothing younger', async () => {
    await seed(TENANT_A, ALICE, 'pg-a-old', 'held', { admittedDaysAgo: 2400, finishedDaysAgo: 2300 });
    await seed(TENANT_A, ALICE, 'pg-a-edge', 'held', { admittedDaysAgo: 2400, finishedDaysAgo: 2189 });
    await seed(TENANT_B, BOB, 'pg-b-old', 'held', { admittedDaysAgo: 2400, finishedDaysAgo: 2300 });
    const present = (key: string) => owner(async (c) => (await c.query('SELECT 1 FROM public.agentic_explain_runs WHERE key_hash = $1', [sha(key)])).rowCount === 1);
    const first = await operator('public.agentic_explain_run_purge($1::text)', [TENANT_A]);
    expect(first.value.deleted).toBeGreaterThanOrEqual(1); // other tests left expired rows of this organization too
    expect(await present('pg-a-old')).toBe(false);
    expect(await present('pg-a-edge')).toBe(true);
    expect(await present('pg-b-old')).toBe(true); // named organization only
    expect(await operator('public.agentic_explain_run_purge($1::text)', [TENANT_A])).toEqual({ kind: 'ok', value: { deleted: 0 } }); // control: nothing left to purge for it
    expect((await operator('public.agentic_explain_run_purge(NULL::text)')).value.deleted).toBeGreaterThanOrEqual(1); // NULL reaches every organization
    expect(await present('pg-b-old')).toBe(false);
    expect(await present('pg-a-edge')).toBe(true);
    expect(await operator('public.agentic_explain_run_purge($1::text)', ['a tenant with spaces'])).toEqual({ kind: 'refused', code: 'INVALID_INPUT' });
  });
  it('no login can run either (control: the owner just did)', async () => {
    for (const url of [db.appUrl, db.workerUrl, db.verifierUrl, db.issuerUrl]) {
      for (const sql of ['SELECT public.agentic_explain_run_sweep()', `SELECT public.agentic_explain_run_purge('x')`]) {
        await expect(as(url, await mint(TENANT_A, ALICE), (c) => c.query(sql))).rejects.toMatchObject({ code: '42501' });
      }
    }
  });
});

describe("the deadline is the database's, and a caller cannot choose what the trigger decides", () => {
  const operator = (sql: string, args: unknown[] = []) =>
    owner(async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE telesphoros_jobs');
      const r = (await c.query(`SELECT ${sql} AS r`, args)).rows[0].r as Json;
      await c.query('COMMIT');
      return r;
    });
  it('a move past the deadline closes the run and is refused as DEADLINE, whatever the process clock says; the expiry itself is allowed once the deadline has passed', async () => {
    const late = await seed(TENANT_A, ALICE, 'dl-late', 'running', { admittedDaysAgo: 1 });
    expect(await alice((c) => advance(c, late, { state: 'running', sequence: 0, fence: 1 }, 'reviewing'))).toEqual({ kind: 'refused', code: 'DEADLINE' });
    expect(await alice((c) => get(c, late))).toMatchObject({ value: { state: 'expired', sequence: 1 } });
    expect(await alice((c) => advance(c, late, { state: 'expired', sequence: 1, fence: 1 }, 'held'))).toEqual({ kind: 'refused', code: 'INVALID_TRANSITION' });
    const expiring = await seed(TENANT_A, ALICE, 'dl-expiring', 'running', { admittedDaysAgo: 1 });
    expect(await alice((c) => advance(c, expiring, { state: 'running', sequence: 0, fence: 1 }, 'expired'))).toMatchObject({ kind: 'ok', value: { state: 'expired' } });
    // Control: a run still inside its deadline moves.
    const fresh = await newRun(alice, 'dl-fresh');
    expect(await alice((c) => advance(c, fresh.id, expectOf(fresh), 'queued'))).toMatchObject({ kind: 'ok', value: { state: 'queued' } });
    // And cancel still works for a run that is not past it.
    expect(await alice((c) => cancel(c, fresh.id))).toMatchObject({ kind: 'ok', value: { state: 'cancelled', fence: 2 } });
  });
  const tamper = async (superuser: boolean, work: (c: Client) => Promise<void>) =>
    owner(async (c) => {
      await c.query('BEGIN');
      if (!superuser) await c.query('SET LOCAL ROLE telesphoros_jobs');
      await work(c);
      await c.query('ROLLBACK');
    });
  it.each([
    ['a role with no superuser', false],
    ['a superuser', true],
  ])('as %s: an inserted run always starts admitted at sequence 0 and fence 1, now, with the deadline 120 seconds on, whatever the statement says', async (_name, superuser) => {
    await tamper(superuser, async (c) => {
      const row = (
        await c.query(
          `INSERT INTO public.agentic_explain_runs (tenant_id, requester_ref, key_hash, tuple_digest, harness_version, state, sequence, fence, mono_at, admitted_at, deadline_at, finished_at)
           VALUES ('run-a', 'x', $1, $2, $3, 'held', 9, 4, 1, '2000-01-01', '2000-01-02', '2000-01-03')
           RETURNING state, sequence::int AS sequence, fence::int AS fence, finished_at,
                     extract(epoch FROM (clock_timestamp() - admitted_at)) AS age, extract(epoch FROM (deadline_at - admitted_at)) AS window`,
          [sha(`planted-${superuser}`), HMAC('c'), sha('h')],
        )
      ).rows[0];
      expect(row).toMatchObject({ state: 'admitted', sequence: 0, fence: 1, finished_at: null });
      expect(Number(row.age)).toBeLessThan(5);
      expect(Number(row.window)).toBe(120);
    });
  });
  it('an update that finishes a run stamps the finish time itself, so a back-dated finish cannot make the run deletable', async () => {
    const r = await seed(TENANT_A, ALICE, 'dl-stamp', 'running');
    await owner(async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE telesphoros_jobs');
      const done = (
        await c.query(
          `UPDATE public.agentic_explain_runs SET state = 'held', sequence = sequence + 1, finished_at = '2000-01-01' WHERE run_id = $1 RETURNING extract(epoch FROM (clock_timestamp() - finished_at)) AS age`,
          [r],
        )
      ).rows[0];
      expect(Number(done.age)).toBeLessThan(5);
      await c.query('SAVEPOINT s');
      await expect(c.query('DELETE FROM public.agentic_explain_runs WHERE run_id = $1', [r])).rejects.toMatchObject({ code: '23000' });
      await c.query('ROLLBACK TO s');
      await c.query('ROLLBACK');
    });
  });
  it('a sweep skips a row a worker holds instead of failing, two sweeps at once neither fail nor deadlock, and the skipped row is taken by the next sweep', async () => {
    const held = await seed(TENANT_A, ALICE, 'sw2-held', 'running', { admittedDaysAgo: 1 });
    const free = await seed(TENANT_A, ALICE, 'sw2-free', 'queued', { admittedDaysAgo: 1 });
    const locker = new Client({ connectionString: db.adminUrl });
    await locker.connect();
    try {
      await locker.query('BEGIN');
      await locker.query('SELECT 1 FROM public.agentic_explain_runs WHERE run_id = $1 FOR UPDATE', [held]); // a worker in the middle of an advance
      const started = Date.now();
      const out = await operator('public.agentic_explain_run_sweep()');
      expect(Date.now() - started).toBeLessThan(1500); // it did not wait out the 2 s lock timeout
      expect(out.kind).toBe('ok');
      const states = Object.fromEntries(
        (await owner((c) => c.query('SELECT run_id, state FROM public.agentic_explain_runs WHERE run_id = ANY($1::uuid[])', [[held, free]]))).rows.map((x) => [x.run_id, x.state]),
      );
      expect(states).toEqual({ [held]: 'running', [free]: 'expired' });
    } finally {
      await locker.query('ROLLBACK');
      await locker.end();
    }
    const more = await Promise.all(Array.from({ length: 6 }, (_, i) => seed(TENANT_A, ALICE, `sw2-many-${i}`, 'running', { admittedDaysAgo: 1 })));
    const both = await Promise.all([operator('public.agentic_explain_run_sweep()'), operator('public.agentic_explain_run_sweep()')]);
    for (const r of both) expect(r.kind).toBe('ok');
    const left = (await owner((c) => c.query('SELECT state FROM public.agentic_explain_runs WHERE run_id = ANY($1::uuid[])', [[held, ...more]]))).rows.map((x) => x.state);
    expect(left.every((x) => x === 'expired')).toBe(true); // the second sweep (or the first) took the row the worker had released
  });
});

describe('what the table can hold, and who can reach it', () => {
  const factsOn = async (c: Client) => ({
    columns: (
      await c.query(
        `SELECT a.attnum, a.attname, format_type(a.atttypid, a.atttypmod) AS type FROM pg_attribute a WHERE a.attrelid = 'public.agentic_explain_runs'::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY 1`,
      )
    ).rows as Array<{ attnum: number; attname: string; type: string }>,
    checks: (await c.query(`SELECT pg_get_constraintdef(oid) AS def, conkey FROM pg_constraint WHERE conrelid = 'public.agentic_explain_runs'::regclass AND contype = 'c'`))
      .rows as Array<{ def: string; conkey: number[] }>,
  });
  const unbound = (f: Awaited<ReturnType<typeof factsOn>>) =>
    f.columns
      .filter((col) => col.type === 'text' && !f.checks.some((chk) => chk.conkey.length === 1 && chk.conkey[0] === col.attnum && /~|ANY \(ARRAY|= '/.test(chk.def)))
      .map((col) => col.attname);
  it('has no json, bytea or array column and every text column is bound to a pattern or a list; the same test catches a text column with no check', async () => {
    await owner(async (c) => {
      const f = await factsOn(c);
      expect(f.columns.map((x) => x.type).filter((t) => !['uuid', 'text', 'bigint', 'timestamp with time zone'].includes(t))).toEqual([]);
      expect(unbound(f)).toEqual([]);
      await c.query('BEGIN');
      await c.query('ALTER TABLE public.agentic_explain_runs ADD COLUMN note text');
      expect(unbound(await factsOn(c))).toEqual(['note']);
      await c.query('ROLLBACK');
    });
  });
  it("is owned by telesphoros_jobs with forced row security and no login privilege; the functions are definers with a fixed search_path; only the application runs the four capability-bound ones; the identity helper is the family's own", async () => {
    await owner(async (c) => {
      const t = (
        await c.query(
          `SELECT pg_get_userbyid(relowner) AS owner, relrowsecurity, relforcerowsecurity, relacl::text AS acl FROM pg_class WHERE oid = 'public.agentic_explain_runs'::regclass`,
        )
      ).rows[0];
      expect(t).toMatchObject({ owner: 'telesphoros_jobs', relrowsecurity: true, relforcerowsecurity: true });
      expect(t.acl ?? '').not.toMatch(/telesphoros_(app|worker|ledger_verifier|issuer)/);
      const fns = (
        await c.query(
          `SELECT p.proname, pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.proconfig::text AS config, p.prosrc,
                  has_function_privilege('telesphoros_app', p.oid, 'EXECUTE') AS app, has_function_privilege('telesphoros_worker', p.oid, 'EXECUTE') AS worker,
                  has_function_privilege('telesphoros_ledger_verifier', p.oid, 'EXECUTE') AS verifier, has_function_privilege('telesphoros_issuer', p.oid, 'EXECUTE') AS issuer,
                  has_function_privilege('public', p.oid, 'EXECUTE') AS pub
           FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND (p.proname LIKE 'agentic_explain_run%' OR p.proname = 'agentic_explain_transition_ok') ORDER BY 1`,
        )
      ).rows;
      expect(fns.map((f) => f.proname)).toEqual([
        'agentic_explain_run_admit',
        'agentic_explain_run_advance',
        'agentic_explain_run_cancel',
        'agentic_explain_run_get',
        'agentic_explain_run_guard',
        'agentic_explain_run_json',
        'agentic_explain_run_purge',
        'agentic_explain_run_sweep',
        'agentic_explain_transition_ok',
      ]);
      const appMay = new Set(['agentic_explain_run_admit', 'agentic_explain_run_advance', 'agentic_explain_run_cancel', 'agentic_explain_run_get']);
      for (const f of fns) {
        expect(f).toMatchObject({ owner: 'telesphoros_jobs', app: appMay.has(f.proname), worker: false, verifier: false, issuer: false, pub: false });
        expect(f.config).toMatch(/search_path=pg_catalog, pg_temp/);
        if (appMay.has(f.proname)) {
          expect(f.prosecdef).toBe(true);
          expect(f.prosrc).toMatch(/agentic_explain_identity\(\)/);
          expect(f.prosrc).not.toMatch(/agentic_synthetic_|app\.current_(tenant_id|actor)/);
        }
      }
      expect((await c.query(`SELECT has_schema_privilege('telesphoros_jobs', 'public', 'CREATE') AS can`)).rows[0].can).toBe(false);
    });
    for (const url of [db.appUrl, db.workerUrl]) {
      for (const sql of [
        'SELECT 1 FROM public.agentic_explain_runs',
        'DELETE FROM public.agentic_explain_runs',
        `UPDATE public.agentic_explain_runs SET sequence = 0`,
        'TRUNCATE public.agentic_explain_runs',
      ]) {
        await expect(as(url, undefined, (c) => c.query(sql))).rejects.toMatchObject({ code: '42501' });
      }
    }
  });
});

describe('the down migration', () => {
  it('drops the table and the functions when the table is empty', async () => {
    const fresh = await createEphemeralDatabase();
    try {
      const undo = revertThrough('agentic_explain_runs');
      await withAdmin(fresh.adminUrl, async (c) => expect(await migrateDown(c, undo.steps)).toEqual(undo.reverted));
      const left = await withAdmin(fresh.adminUrl, async (c) => ({
        table: (await c.query(`SELECT to_regclass('public.agentic_explain_runs') AS t`)).rows[0].t,
        fns: (await c.query(`SELECT proname FROM pg_proc WHERE proname LIKE 'agentic_explain_run%' OR proname = 'agentic_explain_transition_ok'`)).rowCount,
        receipts: (await c.query(`SELECT to_regclass('public.agentic_explain_receipts') AS t`)).rows[0].t,
      }));
      expect(left.table).toBeNull();
      expect(left.fns).toBe(0);
      expect(left.receipts).not.toBeNull(); // 0048 is below 0049 and stays
    } finally {
      await fresh.drop();
    }
  });
  it('refuses to drop a populated table unless the exact setting is given, and the refusal rolls back whole', async () => {
    const fresh = await createEphemeralDatabase();
    try {
      // Isolate 0049 before its refusal checks: migrateDown commits each version,
      // so a later empty migration must not be expected again after a refusal.
      const above = revertAbove('agentic_explain_runs');
      expect(await withAdmin(fresh.adminUrl, (c) => migrateDown(c, above.steps))).toEqual(above.reverted);
      await withAdmin(fresh.adminUrl, (c) =>
        c.query(
          `INSERT INTO public.agentic_explain_runs (tenant_id, requester_ref, key_hash, tuple_digest, harness_version, state, mono_at, deadline_at)
           VALUES ('run-down', 'x', $1, $2, $3, 'admitted', 1, clock_timestamp() + interval '1 minute')`,
          [sha('down'), HMAC('c'), sha('h')],
        ),
      );
      await withAdmin(fresh.adminUrl, async (c) => {
        await expect(migrateDown(c, 1)).rejects.toThrow(/Refusing to drop agentic_explain_runs/);
        expect((await c.query(`SELECT to_regclass('public.agentic_explain_runs') AS t`)).rows[0].t).not.toBeNull();
        await c.query(`SET telesphoros.allow_runs_drop = 'Yes'`);
        await expect(migrateDown(c, 1)).rejects.toThrow(/Refusing to drop agentic_explain_runs/);
        await c.query(`SET telesphoros.allow_runs_drop = 'yes'`);
        expect(await migrateDown(c, 1)).toEqual(['0049']);
      });
    } finally {
      await fresh.drop();
    }
  });
});
