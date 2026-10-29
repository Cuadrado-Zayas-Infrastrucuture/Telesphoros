import { createHash, randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import { Client } from 'pg';
import { authorityContextMiddleware, bindRequestCapability } from '../../src/auth/authority-context';
import { Database } from '../../src/db/database';
import { PostgresSecurityEvents } from '../../src/security-events/security-events';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';
import { registerTenantRow } from '../helpers/membership';

/**
 * Spec 015 (audit A3, capability mode): a refusal made after the request's capability expired is recorded under that capability, as long as it is not
 * revoked and expired no more than five minutes ago. The organization and the person come from the capability, never from the settings, in both
 * modes; nothing but the event sees the grace. Synthetic data only.
 */
let db: EphemeralDatabase;
let database: Database;
let events: PostgresSecurityEvents;
const owner = <T>(work: (c: Client) => Promise<T>) => withAdmin(db.adminUrl, work);
const hashOf = (value: string) => createHash('sha256').update(value, 'utf8').digest();

type Capability = { token: string; expiresAt: Date };

/** Mints through the issuer login, as the real issuer does before the API opens its transaction. */
async function issue(): Promise<Capability> {
  const token = randomBytes(32).toString('base64url');
  const c = new Client({ connectionString: db.issuerUrl });
  await c.connect();
  try {
    const { rows } = await c.query<{ expires_at: Date }>('SELECT * FROM tenant_capability_issue($1, $2, $3, $4, $5, $6)', [
      'org-alpha',
      'alice',
      1,
      'request',
      hashOf(token),
      'req-grace-00001',
    ]);
    return { token, expiresAt: rows[0]!.expires_at };
  } finally {
    await c.end();
  }
}

/** A capability that expired `minutes` ago, in the database and in the request's own copy alike. */
async function expiredAgo(minutes: number): Promise<Capability> {
  const capability = await issue();
  const shift = `${minutes + 1} minutes`; // lifetime is 60 s: moving both ends back by minutes + 1 leaves it expired `minutes` ago
  await owner((c) =>
    c.query(`UPDATE tenant_capabilities SET issued_at = issued_at - $2::interval, expires_at = expires_at - $2::interval WHERE token_hash = $1`, [hashOf(capability.token), shift]),
  );
  return { token: capability.token, expiresAt: new Date(capability.expiresAt.getTime() - (minutes + 1) * 60_000) };
}

/** Runs `work` inside a request's slot holding this capability, as AuthGuard leaves it. */
function inRequest<T>(capability: Capability, work: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    authorityContextMiddleware({ id: 'req-grace' } as unknown as Request, {} as Response, () => {
      bindRequestCapability({ ...capability, membershipVersion: 1 });
      work().then(resolve, reject);
    });
  });
}

/** One application transaction set up by hand: the settings `withTenant` sets, then the capability if any, then `work`. */
async function asApp<T>(settings: { tenant: string; actor: string }, token: string | undefined, work: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: db.appUrl });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.current_tenant_id', $1, true), set_config('app.current_actor', $2, true)`, [settings.tenant, settings.actor]);
    if (token) await c.query(`SELECT set_config('app.capability', $1, true)`, [token]);
    const out = await work(c);
    await c.query('COMMIT');
    return out;
  } catch (error) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await c.end();
  }
}

const append = (reason: string) => (c: Client) =>
  c.query(`SELECT security_event_append('intake.rejected', 'refused', 'person', 'alice', jsonb_build_object('reason', $1::text), 'req-grace')`, [reason]);
const count = (table: 'patients' | 'tenant_memberships') => (c: Client) => c.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`).then((r) => r.rows[0]!.n);
const alice = { tenant: 'org-alpha', actor: 'alice' };

/** Who each recorded event with this reason was written for. */
const recorded = (reason: string) =>
  owner(
    async (c) =>
      (
        await c.query<{ tenant_id: string; actor_ref: string }>(
          `SELECT tenant_id, actor_ref FROM security_events WHERE event_type = 'intake.rejected' AND details ->> 'reason' = $1 ORDER BY occurred_at`,
          [reason],
        )
      ).rows,
  );

beforeAll(async () => {
  db = await createEphemeralDatabase();
  database = new Database({ url: db.appUrl, ssl: 'disable' });
  events = new PostgresSecurityEvents(database);
  await owner(async (c) => {
    await registerTenantRow(c, 'org-alpha');
    await registerTenantRow(c, 'org-beta');
    await c.query(`INSERT INTO tenant_memberships (tenant_id, sub, status, roles, changed_by) VALUES ('org-alpha', 'alice', 'active', ARRAY['clinician'], 'test')`);
    await c.query(`INSERT INTO patients (tenant_id, created_by, label) VALUES ('org-alpha', 'alice', 'SYN-grace-1')`);
  });
});
afterAll(async () => {
  await database?.onModuleDestroy();
  await db?.drop();
});

describe.each(['dual', 'capability'] as const)('in %s mode', (mode) => {
  beforeAll(() => owner((c) => c.query(`UPDATE tenant_binding_mode SET mode = $1`, [mode])));
  const reason = (label: string) => `${mode}-${label}`;

  it('records a refusal made after a slow upload, for the person the capability names (US1)', async () => {
    const capability = await expiredAgo(2);
    const logged = jest.spyOn(events['logger'], 'error');
    await inRequest(capability, () => events.recordIntakeRejected('org-alpha', 'alice', reason('slow') as never));
    expect(logged).not.toHaveBeenCalled();
    logged.mockRestore();
    expect(await recorded(reason('slow'))).toEqual([{ tenant_id: 'org-alpha', actor_ref: 'alice' }]);
  });

  it('takes the person from the capability, not from the settings (US1, scenario 2)', async () => {
    const capability = await expiredAgo(2);
    await asApp({ tenant: 'org-alpha', actor: 'mallory' }, capability.token, append(reason('from-capability')));
    expect(await recorded(reason('from-capability'))).toEqual([{ tenant_id: 'org-alpha', actor_ref: 'alice' }]);
  });

  it.each([
    ['expired longer ago than the grace window', async () => (await expiredAgo(6)).token, alice],
    [
      'revoked',
      async () => {
        const { token } = await issue();
        await owner((c) => c.query(`UPDATE tenant_capabilities SET revoked_at = now() WHERE token_hash = $1`, [hashOf(token)]));
        return token;
      },
      alice,
    ],
    ['within the window, with settings naming another organization', async () => (await expiredAgo(2)).token, { tenant: 'org-beta', actor: 'alice' }],
  ])('refuses a refusal recorded under a capability %s (US2)', async (label, token, settings) => {
    const why = reason(label.split(' ')[0]!);
    await expect(asApp(settings, await token(), append(why))).rejects.toMatchObject({ code: '42501' });
    expect(await recorded(why)).toEqual([]);
  });

  it('gives a transaction within the window no organization to read (US2, scenario 4)', async () => {
    const valid = await issue();
    expect(await asApp(alice, valid.token, count('patients'))).toBe(1); // control: the same read under a valid capability
    const capability = await expiredAgo(2);
    expect(await asApp(alice, capability.token, count('patients'))).toBe(0);
    expect(await asApp(alice, capability.token, count('tenant_memberships'))).toBe(0);
  });

  it('records a refusal under a valid capability once, and throttles a second within the minute (US3)', async () => {
    const capability = await issue();
    await inRequest(capability, () => events.recordIntakeRejected('org-alpha', 'alice', reason('size') as never));
    await inRequest(capability, () => events.recordIntakeRejected('org-alpha', 'alice', reason('size') as never));
    expect(await recorded(reason('size'))).toEqual([{ tenant_id: 'org-alpha', actor_ref: 'alice' }]);
  });
});

it('still refuses a refusal with no capability at all in capability mode (US2, scenario 5)', async () => {
  await owner((c) => c.query(`UPDATE tenant_binding_mode SET mode = 'capability'`));
  await expect(asApp(alice, undefined, append('capability-none'))).rejects.toMatchObject({ code: '42501' });
  expect(await recorded('capability-none')).toEqual([]);
});

/**
 * FR-003: the grace may not outlast the sweep's retention, or a capability inside the window could already be deleted and the refusal lost. Both are read
 * from the live definitions, so a migration that changes either is checked.
 */
function graceProblem(graceDef: string, sweepDef: string): string | undefined {
  const grace = /expires_at > statement_timestamp\(\) - interval '(\d+) minutes'/.exec(graceDef);
  const retention = /expires_at < clock_timestamp\(\) - interval '(\d+) minutes'/.exec(sweepDef);
  if (!grace) return 'security_event_capability() states no grace window in minutes';
  if (!retention) return 'tenant_capabilities_sweep() states no retention in minutes';
  if (Number(grace[1]) > Number(retention[1])) return `the grace window (${grace[1]} minutes) outlasts the sweep's retention (${retention[1]} minutes)`;
  return undefined;
}

describe('the grace window and the sweep (FR-003)', () => {
  const definitions = () =>
    owner(async (c) => {
      const def = async (fn: string) => (await c.query<{ d: string }>(`SELECT pg_get_functiondef($1::regprocedure) AS d`, [fn])).rows[0]!.d;
      return { grace: await def('public.security_event_capability()'), sweep: await def('public.tenant_capabilities_sweep(integer)') };
    });

  it('keeps the grace no longer than the retention', async () => {
    const { grace, sweep } = await definitions();
    expect(graceProblem(grace, sweep)).toBeUndefined();
  });

  it('reports a grace of 10 minutes (control)', async () => {
    const { grace, sweep } = await definitions();
    const longer = grace.replace("statement_timestamp() - interval '5 minutes'", "statement_timestamp() - interval '10 minutes'");
    expect(longer).not.toBe(grace);
    expect(graceProblem(longer, sweep)).toBe("the grace window (10 minutes) outlasts the sweep's retention (5 minutes)");
  });

  it('reports a grace it cannot read (control)', async () => {
    const { sweep } = await definitions();
    expect(graceProblem('no window here', sweep)).toBe('security_event_capability() states no grace window in minutes');
  });
});
