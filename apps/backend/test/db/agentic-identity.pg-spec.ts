import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { migrateDown, migrateUp } from '../../src/db/migrator';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';
import { revertThrough } from '../helpers/migration-history';
import { migrationsThrough } from '../helpers/migrations-through';
import { registerTenantRow } from '../helpers/membership';

/**
 * P2 option B (migration 0030): the three application entry points of the synthetic durable workflow take their caller from a presented tenant
 * capability, never from the raw session settings, and they do so in EVERY binding mode. In the default mode (`guc`) and in `dual`, app_tenant() and
 * app_actor() alone fall back to the settings when no capability is set (0028), so a bare swap of the reads would protect nothing: every hostile case
 * below runs in all three modes, each next to a positive control that succeeds in the same mode with an issued capability.
 *
 * Every login is a real login (the application and the issuer), never a superuser using SET ROLE. Data is synthetic and written by hand.
 */
jest.setTimeout(120_000);

type Json = Record<string, unknown>;
const MODES = ['guc', 'dual', 'capability'] as const;
let db: EphemeralDatabase;

const token = () => randomBytes(32).toString('base64url');
const hashOf = (value: string) => createHash('sha256').update(value, 'utf8').digest();
const owner = <T>(work: (c: Client) => Promise<T>) => withAdmin(db.adminUrl, work);
const setMode = (mode: string) => owner((c) => c.query('UPDATE tenant_binding_mode SET mode = $1', [mode]));

interface World {
  tenant: string;
  actor: string;
  grantId: string;
  caller: Json;
}

/** One organization with one active member, a grant and one eligible source. Seeded by the owner, as the P2 fixtures are (nothing is seeded by a migration). */
async function world(name: string): Promise<World> {
  const tenant = `p2b-${name}`;
  const actor = `${name}-alice`;
  const grantId = randomUUID();
  const body = `Synthetic source for ${name}`;
  await owner(async (c) => {
    await registerTenantRow(c, tenant);
    await c.query(`INSERT INTO tenant_memberships (tenant_id, sub, status, roles, changed_by) VALUES ($1, $2, 'active', ARRAY['reader'], 'test')`, [tenant, actor]);
    await c.query(`INSERT INTO public.agentic_synthetic_capacity (singleton, tenant_day_units, fleet_month_units) VALUES (1, 5000000, 300000000) ON CONFLICT DO NOTHING`);
    await c.query(
      `INSERT INTO public.agentic_synthetic_grants (tenant_id, grant_id, requester_ref, generation, purpose, capabilities, enabled, expires_at)
      VALUES ($1, $2, $3, 1, 'business-assistance', ARRAY['business.sop.read', 'business.sop.draft']::text[], true, clock_timestamp() + interval '1 hour')`,
      [tenant, grantId, actor],
    );
    await c.query(`INSERT INTO public.agentic_synthetic_sources (tenant_id, source_id, source_version, digest, body, eligible) VALUES ($1, 'source-1', 'v1', $2, $3, true)`, [
      tenant,
      `sha256:${createHash('sha256').update(body, 'utf8').digest('hex')}`,
      body,
    ]);
    await c.query(`INSERT INTO public.agentic_synthetic_grant_sources (tenant_id, grant_id, source_id, source_version, enabled) VALUES ($1, $2, 'source-1', 'v1', true)`, [
      tenant,
      grantId,
    ]);
  });
  return { tenant, actor, grantId, caller: { tenantId: tenant, requesterRef: actor, membershipVersion: '1', grantId, grantGeneration: '1' } };
}

/** Mints through the issuer login and commits, as the real issuer does before the API opens its transaction. */
async function mint(tenant: string, sub: string, version = 1): Promise<string> {
  const value = token();
  const c = new Client({ connectionString: db.issuerUrl });
  await c.connect();
  try {
    const { rows } = await c.query<{ refusal: string | null }>('SELECT * FROM tenant_capability_issue($1, $2, $3, $4, $5, $6)', [
      tenant,
      sub,
      version,
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

interface Binding {
  tenant?: string;
  actor?: string;
  capability?: string;
}

/** The application login, one transaction, these transaction-local settings. Rolled back unless `commit`. */
async function app<T>(binding: Binding, work: (c: Client) => Promise<T>, commit = false): Promise<T> {
  const c = new Client({ connectionString: db.appUrl });
  await c.connect();
  try {
    await c.query('BEGIN');
    if (binding.tenant !== undefined) await c.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [binding.tenant]);
    if (binding.actor !== undefined) await c.query(`SELECT set_config('app.current_actor', $1, true)`, [binding.actor]);
    if (binding.capability !== undefined) await c.query(`SELECT set_config('app.capability', $1, true)`, [binding.capability]);
    const result = await work(c);
    await c.query(commit ? 'COMMIT' : 'ROLLBACK');
    return result;
  } catch (error) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await c.end();
  }
}

const request = (key: string) => ({
  schemaVersion: 'agentic.request.v1',
  taskKey: 'business.sop-draft.v1',
  locale: 'en',
  question: 'How do I wash hands? (synthetic)',
  idempotencyKey: key,
});
const admit = async (c: Client, key: string, caller: Json) =>
  (await c.query('SELECT public.agentic_synthetic_admit($1::jsonb, $2::jsonb) AS r', [JSON.stringify(request(key)), JSON.stringify(caller)])).rows[0].r as Json;
const read = async (c: Client, runId: string, caller: Json) =>
  (await c.query('SELECT public.agentic_synthetic_read($1::uuid, $2::jsonb) AS r', [runId, JSON.stringify(caller)])).rows[0].r as Json;
const cancel = async (c: Client, runId: string, caller: Json) =>
  (await c.query('SELECT public.agentic_synthetic_cancel($1::uuid, $2::jsonb) AS r', [runId, JSON.stringify(caller)])).rows[0].r as Json;
const REFUSED = { kind: 'refused', code: 'NOT_AUTHORIZED' };

/** Rows the owner can see for one organization: the hostile cases must leave all of them exactly as they were. */
const counts = (tenant: string) =>
  owner(
    async (c) =>
      (
        await c.query(
          `SELECT
  (SELECT count(*)::int FROM public.agentic_synthetic_runs WHERE tenant_id = $1) AS runs,
  (SELECT count(*)::int FROM public.agentic_synthetic_outcomes WHERE tenant_id = $1) AS outcomes,
  (SELECT count(*)::int FROM public.agentic_synthetic_audit WHERE tenant_id = $1) AS audit,
  (SELECT count(*)::int FROM public.jobs WHERE tenant_id = $1 AND type = 'test.agentic-synthetic') AS jobs`,
          [tenant],
        )
      ).rows[0],
  );

/** Admits one run with a fresh capability and commits it. */
async function admitted(w: World, key = 'p2b/1'): Promise<string> {
  const capability = await mint(w.tenant, w.actor);
  const result = await app({ tenant: w.tenant, actor: w.actor, capability }, (c) => admit(c, key, w.caller), true);
  expect(result).toMatchObject({ kind: 'ok', value: { kind: 'new', state: 'queued' } });
  return (result as { value: { runId: string } }).value.runId;
}

/** Cancels a committed run with a fresh capability. P2 allows two runs in flight across the whole fleet, so every test that commits a run settles it. */
async function settle(w: World, runId: string): Promise<void> {
  const capability = await mint(w.tenant, w.actor);
  expect(await app({ tenant: w.tenant, actor: w.actor, capability }, (c) => cancel(c, runId, w.caller), true)).toMatchObject({ kind: 'ok', value: { terminalState: 'cancelled' } });
}

beforeAll(async () => {
  db = await createEphemeralDatabase();
});
afterAll(async () => {
  await setMode('guc').catch(() => undefined);
  await db.drop();
});

describe('the login under test is the application, not a superuser', () => {
  it('has no superuser or BYPASSRLS, and the binding mode starts at dual (0032)', async () => {
    const row = await app(
      {},
      async (c) =>
        (await c.query(`SELECT rolsuper, rolbypassrls, pg_has_role(current_user, 'telesphoros_app', 'MEMBER') AS app FROM pg_roles WHERE rolname = current_user`)).rows[0],
    );
    expect(row).toEqual({ rolsuper: false, rolbypassrls: false, app: true });
    expect(await owner(async (c) => (await c.query('SELECT mode FROM tenant_binding_mode')).rows)).toEqual([{ mode: 'dual' }]);
  });
});

describe.each(MODES)('hostile application login, binding mode %s', (mode) => {
  let w: World;
  let runId: string;
  let valid: string;

  beforeAll(async () => {
    await setMode(mode);
    w = await world(`hostile-${mode}`);
    valid = await mint(w.tenant, w.actor);
  });
  afterAll(async () => {
    await setMode('guc');
  });

  it('settings forged to the person, no capability: admit is refused and nothing is written; control: the same admit with the capability would have worked', async () => {
    const forged = { tenant: w.tenant, actor: w.actor };
    expect(await app(forged, (c) => admit(c, 'p2b/forged', w.caller))).toEqual(REFUSED);
    expect(await counts(w.tenant)).toEqual({ runs: 0, outcomes: 0, audit: 0, jobs: 0 });
    expect(await app({ ...forged, capability: valid }, (c) => admit(c, 'p2b/forged', w.caller))).toMatchObject({ kind: 'ok', value: { kind: 'new' } }); // rolled back
    expect(await counts(w.tenant)).toEqual({ runs: 0, outcomes: 0, audit: 0, jobs: 0 });
  });

  it('positive control: with an issued capability for the person, admit commits one run', async () => {
    runId = await admitted(w);
    expect(await counts(w.tenant)).toEqual({ runs: 1, outcomes: 0, audit: expect.any(Number), jobs: 1 });
  });

  it('settings forged to the person, no capability: read and cancel are refused and nothing changes', async () => {
    const before = await counts(w.tenant);
    const forged = { tenant: w.tenant, actor: w.actor };
    expect(await app(forged, (c) => read(c, runId, w.caller))).toEqual(REFUSED);
    expect(await app(forged, (c) => cancel(c, runId, w.caller), true)).toEqual(REFUSED);
    expect(await counts(w.tenant)).toEqual(before);
    // control, same mode, same run: the capability makes the same read work
    expect(await app({ ...forged, capability: valid }, (c) => read(c, runId, w.caller))).toEqual({ kind: 'ok', value: null });
  });

  it('a capability that is not valid grants nothing: garbage, unknown, revoked, expired', async () => {
    const revoked = await mint(w.tenant, w.actor);
    const expired = await mint(w.tenant, w.actor);
    await owner(async (c) => {
      await c.query('UPDATE tenant_capabilities SET revoked_at = clock_timestamp() WHERE token_hash = $1', [hashOf(revoked)]);
      await c.query(`UPDATE tenant_capabilities SET issued_at = issued_at - interval '5 minutes', expires_at = expires_at - interval '5 minutes' WHERE token_hash = $1`, [
        hashOf(expired),
      ]);
    });
    for (const [label, capability] of [
      ['garbage', 'x'],
      ['unknown', token()],
      ['revoked', revoked],
      ['expired', expired],
    ] as const) {
      const forged = { tenant: w.tenant, actor: w.actor, capability };
      expect([label, await app(forged, (c) => read(c, runId, w.caller))]).toEqual([label, REFUSED]);
      // control after every refusal: the valid capability still works
      expect(await app({ tenant: w.tenant, actor: w.actor, capability: valid }, (c) => read(c, runId, w.caller))).toEqual({ kind: 'ok', value: null });
    }
    expect((await counts(w.tenant)).runs).toBe(1);
  });

  it('positive control: cancel with the capability settles the run', async () => {
    const result = await app({ tenant: w.tenant, actor: w.actor, capability: valid }, (c) => cancel(c, runId, w.caller), true);
    expect(result).toMatchObject({ kind: 'ok', value: { terminalState: 'cancelled' } });
  });
});

describe('the capability decides who is asking, not the settings or the caller document', () => {
  it('a capability for one person with the actor setting forged to another: the admission fails closed and leaves nothing; with the true actor it works', async () => {
    const w = await world('actor-forge');
    const capability = await mint(w.tenant, w.actor);
    const before = await counts(w.tenant);
    // DATA-01 slice 3 (0032): with a capability the actor setting no longer decides who asked. The forged setting is ignored, the admission
    // records the capability's person, and nothing is stored for the forged one.
    const ok = await app({ tenant: w.tenant, actor: 'mallory', capability }, (c) => admit(c, 'p2b/forge', w.caller), true);
    expect(ok).toMatchObject({ kind: 'ok', value: { kind: 'new' } });
    expect(await counts(w.tenant)).not.toEqual(before);
    const stored = await owner(async (c) => (await c.query(`SELECT requested_by FROM public.jobs WHERE tenant_id = $1 AND type = 'test.agentic-synthetic'`, [w.tenant])).rows);
    expect(stored).toEqual([{ requested_by: w.actor }]);
    await settle(w, (ok as { value: { runId: string } }).value.runId);
  });

  it('a capability for one organization with the tenant setting forged to another: refused; with the true tenant it works', async () => {
    const mine = await world('tenant-forge-a');
    const other = await world('tenant-forge-b');
    const runId = await admitted(mine);
    const capability = await mint(mine.tenant, mine.actor);
    expect(await app({ tenant: other.tenant, actor: mine.actor, capability }, (c) => read(c, runId, mine.caller))).toEqual(REFUSED);
    expect(await app({ tenant: other.tenant, actor: mine.actor, capability }, (c) => admit(c, 'p2b/x', other.caller))).toEqual(REFUSED);
    expect(await app({ tenant: mine.tenant, actor: mine.actor, capability }, (c) => read(c, runId, mine.caller))).toEqual({ kind: 'ok', value: null });
    await settle(mine, runId);
  });

  it('a caller document that names another organization or person than the capability is refused; the matching document works', async () => {
    const w = await world('caller-doc');
    const other = await world('caller-doc-b');
    const runId = await admitted(w);
    const capability = await mint(w.tenant, w.actor);
    const binding = { tenant: w.tenant, actor: w.actor, capability };
    expect(await app(binding, (c) => read(c, runId, { ...w.caller, tenantId: other.tenant }))).toEqual(REFUSED);
    expect(await app(binding, (c) => read(c, runId, { ...w.caller, requesterRef: other.actor }))).toEqual(REFUSED);
    // The same on cancel and admit: the document is compared on every entry point, not only on read. Without this, a mutant that drops the
    // comparison from cancel or admit leaves the database refusing nothing here, because the capability already says who is asking.
    expect(await app(binding, (c) => cancel(c, runId, { ...w.caller, tenantId: other.tenant }))).toEqual(REFUSED);
    expect(await app(binding, (c) => cancel(c, runId, { ...w.caller, requesterRef: other.actor }))).toEqual(REFUSED);
    expect(await app(binding, (c) => admit(c, 'p2b/doc', { ...w.caller, tenantId: other.tenant }))).toEqual(REFUSED);
    expect(await app(binding, (c) => admit(c, 'p2b/doc', { ...w.caller, requesterRef: other.actor }))).toEqual(REFUSED);
    expect(await app(binding, (c) => read(c, runId, w.caller))).toEqual({ kind: 'ok', value: null });
    expect(await counts(w.tenant)).toMatchObject({ runs: 1, outcomes: 0 }); // the refused cancels settled nothing, the refused admits wrote nothing
    await settle(w, runId);
  });

  it('a person removed after the capability was issued cannot admit; the same steps without the removal can', async () => {
    const removed = await world('removed');
    const kept = await world('kept');
    const [capRemoved, capKept] = [await mint(removed.tenant, removed.actor), await mint(kept.tenant, kept.actor)];
    await owner((c) => c.query(`UPDATE tenant_memberships SET status = 'removed', changed_by = 'test' WHERE tenant_id = $1 AND sub = $2`, [removed.tenant, removed.actor]));
    expect(await app({ tenant: removed.tenant, actor: removed.actor, capability: capRemoved }, (c) => admit(c, 'p2b/r', removed.caller))).toEqual(REFUSED);
    expect(await app({ tenant: kept.tenant, actor: kept.actor, capability: capKept }, (c) => admit(c, 'p2b/r', kept.caller))).toMatchObject({ kind: 'ok' });
  });
});

describe('read and cancel no longer need the settings at all', () => {
  it('with only the capability set, read and cancel work (control: the same calls with a forged-nothing binding are refused)', async () => {
    const w = await world('no-settings');
    const runId = await admitted(w);
    const capability = await mint(w.tenant, w.actor);
    expect(await app({}, (c) => read(c, runId, w.caller))).toEqual(REFUSED);
    expect(await app({ capability }, (c) => read(c, runId, w.caller))).toEqual({ kind: 'ok', value: null });
    expect(await app({ capability }, (c) => cancel(c, runId, w.caller), true)).toMatchObject({ kind: 'ok', value: { terminalState: 'cancelled' } });
  });

  // A pinned limit, not a goal: membership_assert_current (0017) and job_enqueue (0023) still read the settings. DATA-01 slice 3 moves both onto
  // app_tenant() / app_actor(); this assertion then flips on purpose.
  it('admit needs no settings once the membership check and job_enqueue read the capability (0032): with only the capability it is admitted for its person', async () => {
    const w = await world('admit-no-settings');
    const capability = await mint(w.tenant, w.actor);
    const before = await counts(w.tenant);
    const ok = await app({ capability }, (c) => admit(c, 'p2b/ns', w.caller), true);
    expect(ok).toMatchObject({ kind: 'ok', value: { kind: 'new' } });
    expect(await counts(w.tenant)).not.toEqual(before);
    await settle(w, (ok as { value: { runId: string } }).value.runId);
  });
});

/**
 * DATA-01 slice 5 readiness R2: the worker side checks the requester's membership from the run's own row, never through the tenant setting, so a
 * worker step works in every binding mode, `capability` included, and still stops for a person whose membership changed. Driven by the real worker
 * login: the run is admitted with a capability, claimed with agentic_synthetic_claim and loaded with agentic_synthetic_load.
 */
async function worker<T>(work: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: db.workerUrl });
  await c.connect();
  try {
    return await work(c);
  } finally {
    await c.end();
  }
}

/**
 * Claims this run's P2 job as `worker-r2` and loads the run, as the durable runner's first step does. Jobs other suites in this file left queued are
 * deferred first, so the claim can only return this one.
 */
const claimAndLoad = async (runId: string) => {
  await owner((c) =>
    c.query(`UPDATE public.jobs SET run_after = now() + interval '1 day' WHERE type = 'test.agentic-synthetic' AND state = 'queued' AND payload ->> 'runId' <> $1`, [runId]),
  );
  return worker(async (c) => {
    const { rows } = await c.query('SELECT * FROM public.agentic_synthetic_claim($1, $2)', ['worker-r2', 1]);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    const stamp = { jobId: row.id, runId: row.run_id, workerId: 'worker-r2', queueAttempt: Number(row.attempt), claimId: row.claim_id, fence: String(row.fence) };
    const expected = { sequence: String(row.sequence), state: row.state };
    return (await c.query('SELECT public.agentic_synthetic_load($1::jsonb, $2::jsonb) AS r', [JSON.stringify(stamp), JSON.stringify(expected)])).rows[0].r as Json;
  });
};

describe.each(MODES)('the worker side, binding mode %s (R2)', (mode) => {
  beforeAll(() => setMode(mode));
  afterAll(() => setMode('guc'));

  it('loads a run admitted for a current member', async () => {
    const w = await world(`r2-${mode}`);
    const runId = await admitted(w, `p2b/r2-${mode}`);
    expect(await claimAndLoad(runId)).toMatchObject({ kind: 'ok', value: { runId } });
    await settle(w, runId);
  });

  it('refuses the step once the requester is no longer a current member (control: the same step was allowed above)', async () => {
    const w = await world(`r2-removed-${mode}`);
    const runId = await admitted(w, `p2b/r2-removed-${mode}`);
    await owner((c) => c.query(`UPDATE tenant_memberships SET status = 'removed', changed_by = 'test' WHERE tenant_id = $1 AND sub = $2`, [w.tenant, w.actor]));
    expect(await claimAndLoad(runId)).toEqual(REFUSED);
    await owner((c) => c.query(`UPDATE public.agentic_synthetic_reservations SET in_flight = false WHERE run_id = $1 AND NOT settled`, [runId]));
  });
});

describe('the worker-side membership lookup (R2, migration 0073)', () => {
  /** The lookup as its only grantee calls it (the owner enters the NOLOGIN role, as the worker's definer functions do), in `c`'s open transaction. */
  const lookup = async (c: Client, tenant: string, sub: string, version: number) => {
    await c.query('SET LOCAL ROLE telesphoros_jobs');
    const ok = (await c.query('SELECT public.membership_current_in($1, $2, $3) AS ok', [tenant, sub, version])).rows[0].ok as boolean;
    await c.query('RESET ROLE');
    return ok;
  };
  const inTransaction = <T>(work: (c: Client) => Promise<T>) =>
    owner(async (c) => {
      await c.query('BEGIN');
      try {
        return await work(c);
      } finally {
        await c.query('ROLLBACK');
      }
    });

  it('answers for an active member at that version of an active organization, and nothing else', async () => {
    const w = await world('r2-lookup');
    expect(await inTransaction((c) => lookup(c, w.tenant, w.actor, 1))).toBe(true); // control
    expect(await inTransaction((c) => lookup(c, w.tenant, w.actor, 2))).toBe(false); // another version
    expect(await inTransaction((c) => lookup(c, w.tenant, 'mallory', 1))).toBe(false); // not a member
    // A row that is not active at the very version asked for. A removal through the guard also moves the version, so only a row written this way
    // shows that status is checked on its own.
    await owner((c) =>
      c.query(`INSERT INTO tenant_memberships (tenant_id, sub, status, roles, changed_by) VALUES ($1, 'r2-removed-at-1', 'removed', ARRAY['reader'], 'test')`, [w.tenant]),
    );
    expect(await inTransaction((c) => lookup(c, w.tenant, 'r2-removed-at-1', 1))).toBe(false);
    await owner((c) => c.query(`UPDATE tenants SET status = 'suspended', changed_by = 'test' WHERE id = $1`, [w.tenant]));
    expect(await inTransaction((c) => lookup(c, w.tenant, w.actor, 1))).toBe(false); // the organization is suspended
  });

  it('refuses a worker step after a role change, which moves the membership version (control: the first test of each mode)', async () => {
    await setMode('capability');
    try {
      const w = await world('r2-roles');
      const runId = await admitted(w, 'p2b/r2-roles');
      await owner((c) => c.query(`UPDATE tenant_memberships SET roles = ARRAY['clinician'], changed_by = 'test' WHERE tenant_id = $1 AND sub = $2`, [w.tenant, w.actor]));
      expect(await claimAndLoad(runId)).toEqual(REFUSED);
      await owner((c) => c.query(`UPDATE public.agentic_synthetic_reservations SET in_flight = false WHERE run_id = $1 AND NOT settled`, [runId]));
    } finally {
      await setMode('guc');
    }
  });

  it('holds the membership row until the step commits: a removal waits for it', async () => {
    const w = await world('r2-lock');
    await inTransaction(async (c) => {
      expect(await lookup(c, w.tenant, w.actor, 1)).toBe(true);
      await expect(
        owner(async (other) => {
          await other.query(`SET lock_timeout = '300ms'`);
          await other.query(`UPDATE tenant_memberships SET status = 'removed', changed_by = 'test' WHERE tenant_id = $1 AND sub = $2`, [w.tenant, w.actor]);
        }),
      ).rejects.toMatchObject({ code: '55P03' });
    });
  });

  it('is executable by telesphoros_jobs only, and by no login', async () => {
    for (const [name, url] of [
      ['app', db.appUrl],
      ['worker', db.workerUrl],
      ['verifier', db.verifierUrl],
      ['operator', db.operatorUrl],
      ['auditor', db.auditorUrl],
      ['issuer', db.issuerUrl],
    ] as const) {
      const c = new Client({ connectionString: url });
      await c.connect();
      try {
        const { rows } = await c.query(`SELECT has_function_privilege(current_user, 'public.membership_current_in(text, text, bigint)', 'EXECUTE') AS ok`);
        expect([name, rows[0].ok]).toEqual([name, false]);
      } finally {
        await c.end();
      }
    }
    const acl = await owner(
      async (c) => (await c.query(`SELECT proacl::text AS acl FROM pg_proc WHERE oid = 'public.membership_current_in(text, text, bigint)'::regprocedure`)).rows[0].acl,
    );
    expect(acl).toMatch(/^\{[^,]*=X\/[^,]*,telesphoros_jobs=X\/[^,]*\}$/);
  });

  it('reverts to the 0029 body byte for byte, refuses on a body it was not written against, and re-applies', async () => {
    const body = () =>
      owner(
        async (c) =>
          (await c.query(`SELECT md5(prosrc) AS h FROM pg_proc WHERE oid = 'public.agentic_synthetic_member_current(text, text, bigint)'::regprocedure`)).rows[0].h as string,
      );
    const { steps, reverted } = revertThrough('agentic_worker_membership');
    expect(await owner((c) => migrateDown(c, steps))).toEqual(reverted);
    expect(await body()).toBe('7125c26a77d525ee83b855830fee0bb5'); // the 0029 body
    expect(await owner(async (c) => (await c.query(`SELECT to_regprocedure('public.membership_current_in(text, text, bigint)') IS NULL AS gone`)).rows[0].gone)).toBe(true);
    // a body that is not 0029's: the precondition refuses, and nothing is applied
    const original = await owner(
      async (c) => (await c.query(`SELECT pg_get_functiondef('public.agentic_synthetic_member_current(text, text, bigint)'::regprocedure) AS d`)).rows[0].d as string,
    );
    await owner((c) => c.query(original.replace('RETURN coalesce(v_ok, false);', 'RETURN coalesce(v_ok, false) AND true;')));
    await expect(owner((c) => migrateUp(c))).rejects.toThrow(/Migration 0073 expects the 0029 body/);
    await owner((c) => c.query(original));
    expect(await owner((c) => migrateUp(c))).toEqual([...reverted].reverse());
    expect(await body()).not.toBe('7125c26a77d525ee83b855830fee0bb5');
  });
});

describe('the catalog says the same thing the behaviour does', () => {
  const scan = (src: string) => /app\.current_(tenant_id|actor)/.test(src);

  it('the scanner finds a setting name (control), and no function the application can execute reads one', async () => {
    expect(scan(`current_setting('app.current_actor', true)`)).toBe(true);
    expect(scan(`SELECT public.app_tenant()`)).toBe(false);
    const rows = await owner(
      async (c) =>
        (
          await c.query(`SELECT proname, prosrc FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname LIKE 'agentic_synthetic_%'
      AND has_function_privilege('telesphoros_app', oid, 'EXECUTE') ORDER BY proname`)
        ).rows,
    );
    expect(rows.map((r) => r.proname)).toEqual(['agentic_synthetic_admit', 'agentic_synthetic_cancel', 'agentic_synthetic_read']);
    for (const r of rows) expect([r.proname, scan(r.prosrc), /public\.agentic_synthetic_identity\(\)/.test(r.prosrc)]).toEqual([r.proname, false, true]);
  });

  it('across the whole schema, no P2 function reads a tenant setting (the worker-side member_current moved off it for DATA-01 slice 5, R2)', async () => {
    const names = await owner(async (c) =>
      (await c.query(`SELECT proname, prosrc FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname LIKE 'agentic_synthetic_%' ORDER BY proname`)).rows
        .filter((r) => scan(r.prosrc))
        .map((r) => r.proname),
    );
    expect(names).toEqual([]);
  });

  it('privileges: the helper is executable by no login; the entry points are app-only; the owner can call the helper', async () => {
    const logins = [
      ['app', db.appUrl],
      ['worker', db.workerUrl],
      ['verifier', db.verifierUrl],
      ['operator', db.operatorUrl],
      ['auditor', db.auditorUrl],
      ['issuer', db.issuerUrl],
    ] as const;
    for (const [name, url] of logins) {
      const c = new Client({ connectionString: url });
      await c.connect();
      try {
        const { rows } = await c.query(`SELECT has_function_privilege(current_user, 'public.agentic_synthetic_identity()', 'EXECUTE') AS ok, current_user AS who`);
        expect([name, rows[0].ok]).toEqual([name, false]);
      } finally {
        await c.end();
      }
    }
    expect(await owner(async (c) => (await c.query(`SELECT has_function_privilege('telesphoros_jobs', 'public.agentic_synthetic_identity()', 'EXECUTE') AS ok`)).rows[0].ok)).toBe(
      true,
    );
    const acl = await owner(
      async (c) =>
        (
          await c.query(`SELECT proname, proacl::text AS acl FROM pg_proc WHERE pronamespace = 'public'::regnamespace
      AND proname IN ('agentic_synthetic_identity', 'agentic_synthetic_admit', 'agentic_synthetic_read', 'agentic_synthetic_cancel') ORDER BY proname`)
        ).rows,
    );
    expect(acl).toEqual([
      { proname: 'agentic_synthetic_admit', acl: '{telesphoros_jobs=X/telesphoros_jobs,telesphoros_app=X/telesphoros_jobs}' },
      { proname: 'agentic_synthetic_cancel', acl: '{telesphoros_jobs=X/telesphoros_jobs,telesphoros_app=X/telesphoros_jobs}' },
      { proname: 'agentic_synthetic_identity', acl: '{telesphoros_jobs=X/telesphoros_jobs}' },
      { proname: 'agentic_synthetic_read', acl: '{telesphoros_jobs=X/telesphoros_jobs,telesphoros_app=X/telesphoros_jobs}' },
    ]);
  });
});

describe('migration 0030 on its own database', () => {
  const snapshot = (c: Client) =>
    c
      .query<{ f: string }>(
        `SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') owner=' || pg_get_userbyid(p.proowner)
      || ' acl=' || coalesce(p.proacl::text, '-') || ' config=' || coalesce(array_to_string(p.proconfig, ','), '-') || ' src=' || md5(p.prosrc) AS f
    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace ORDER BY 1`,
      )
      .then((r) => r.rows.map((x) => x.f));
  const sameSchemaExceptP2 = (a: string[], b: string[]) => [
    a.filter((f) => !/^agentic_synthetic_(admit|read|cancel|identity)\(/.test(f)),
    b.filter((f) => !/^agentic_synthetic_(admit|read|cancel|identity)\(/.test(f)),
  ];

  it('applies on top of 0029, changes only the three entry points and adds the helper, and its down restores the 0029 catalog byte for byte', async () => {
    const own = await createEphemeralDatabase({ migrate: false });
    try {
      await withAdmin(own.adminUrl, async (c) => {
        expect(await migrateUp(c, migrationsThrough('0029'))).toContain('0029');
        const at0029 = await snapshot(c);
        expect(await migrateUp(c, migrationsThrough('0030'))).toEqual(['0030']); // through 0030 only: a later migration is not what this test is about
        const at0030 = await snapshot(c);
        expect(at0030).not.toEqual(at0029);
        const [a, b] = sameSchemaExceptP2(at0029, at0030);
        expect(b).toEqual(a); // nothing else in the public schema moved
        expect(at0030.filter((f) => f.startsWith('agentic_synthetic_identity('))).toHaveLength(1);
        for (const name of ['admit', 'read', 'cancel']) {
          const pick = (rows: string[]) => rows.filter((f) => f.startsWith(`agentic_synthetic_${name}(`));
          expect([name, pick(at0030)]).not.toEqual([name, pick(at0029)]); // control: each entry point really changed
        }
        expect(await migrateDown(c, 1)).toEqual(['0030']);
        expect(await snapshot(c)).toEqual(at0029);
        expect(await migrateUp(c, migrationsThrough('0030'))).toEqual(['0030']); // through 0030 only: a later migration is not what this test is about
        expect(await snapshot(c)).toEqual(at0030);
      });
    } finally {
      await own.drop();
    }
  });

  it('refuses, and changes nothing, if a 0029 body is not the one it was written against', async () => {
    const own = await createEphemeralDatabase({ migrate: false });
    try {
      await withAdmin(own.adminUrl, async (c) => {
        await migrateUp(c, migrationsThrough('0029'));
        await c.query(`DO $$ DECLARE d text; BEGIN
          SELECT pg_get_functiondef('public.agentic_synthetic_read(uuid, jsonb)'::regprocedure) INTO d;
          EXECUTE replace(d, 'DECLARE', E'-- drifted\\nDECLARE');
        END $$`);
        const drifted = await snapshot(c);
        await expect(migrateUp(c)).rejects.toThrow(/Migration 0030 failed and was rolled back/);
        expect(await snapshot(c)).toEqual(drifted);
        expect((await c.query(`SELECT count(*)::int AS n FROM schema_migrations WHERE version = '0030'`)).rows[0].n).toBe(0);
      });
    } finally {
      await own.drop();
    }
  });
});
