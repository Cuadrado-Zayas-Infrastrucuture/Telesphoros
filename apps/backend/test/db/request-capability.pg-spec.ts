import { Controller, Get, Req } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { type FakeIdp, startFakeIdp } from '@telesphoros/fake-idp';
import type { Request } from 'express';
import request from 'supertest';
import { asOrganizationWork, currentRequestAuthority, currentRequestCapability } from '../../src/auth/authority-context';
import { CognitoTokenVerifier } from '../../src/auth/cognito-token-verifier';
import { Public } from '../../src/auth/decorators';
import { Database } from '../../src/db/database';
import { CapabilityIssuerPort, type CapabilityIssueRequest, type IssuedCapability } from '../../src/issuer/capability-issuer.port';
import { IssuerCore, PgCapabilityIssueStore } from '../../src/issuer/issuer-core';
import { createTestApp, securityEventsOf } from '../helpers/app';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';
import { registerTenantRow } from '../helpers/membership';
import { bearer } from '../helpers/tokens';

/**
 * DATA-01 T017 end to end (FR-011): the real guard, the real issuer core on the real issuer login, the real application login. One request gets ONE
 * capability, before its first transaction that needs one; every transaction in it, organization work included, carries that capability; the
 * database accepts it. Behaviour with no issuer configured, or a failing one, is today's (binding mode `guc`) and is counted.
 */
jest.setTimeout(120_000);

const holder: { database?: Database } = {};
type Seen = { caps: Array<string | null>; tenants: Array<string | null>; mismatch: Array<string | null>; org: string | null };

@Controller('probe-capability')
class CapabilityProbe {
  @Get('who')
  async who(@Req() req: Request): Promise<Seen> {
    const db = holder.database!;
    const tenantId = req.principal!.tenantId;
    const look = (c: { query: (sql: string) => Promise<{ rows: Array<Record<string, string | null>> }> }) => c.query(`SELECT current_setting('app.capability', true) AS cap, app_tenant() AS tenant`);
    const probe = async () =>
      db.withTenant(tenantId, async (c) => {
        const first = (await look(c)).rows[0]!;
        await c.query(`SELECT set_config('app.current_tenant_id', 'someone-else', true)`);
        const mismatch = (await c.query<{ t: string | null }>('SELECT app_tenant() AS t')).rows[0]!.t;
        return { cap: first.cap || null, tenant: first.tenant, mismatch };
      });
    const a = await probe();
    const b = await probe();
    const org = await asOrganizationWork(() => db.withTenant(tenantId, async (c) => (await look(c)).rows[0]!.cap || null));
    return { caps: [a.cap, b.cap], tenants: [a.tenant, b.tenant], mismatch: [a.mismatch, b.mismatch], org };
  }

  /** A write inside the request: the commit-time check compares the authority the guard bound with the membership row. */
  @Get('write')
  async write(@Req() req: Request): Promise<{ ok: true }> {
    await holder.database!.withTenant(req.principal!.tenantId, (c) => c.query(`INSERT INTO patients (tenant_id, created_by, label) VALUES ($1, $2, $3)`, [req.principal!.tenantId, req.principal!.sub, `SYN-ORDER-${req.id}`]), { actor: req.principal!.sub });
    return { ok: true };
  }

  @Get('read')
  async read(@Req() req: Request): Promise<{ ok: true }> {
    await holder.database!.withTenant(req.principal!.tenantId, (c) => c.query('SELECT count(*)::int FROM patients'));
    return { ok: true };
  }

  @Public()
  @Get('open')
  open() {
    return { ok: true };
  }
}

class Counting extends CapabilityIssuerPort {
  calls = 0;
  constructor(private readonly inner: CapabilityIssuerPort) {
    super();
  }
  async issue(r: CapabilityIssueRequest): Promise<IssuedCapability | undefined> {
    this.calls += 1;
    return this.inner.issue(r);
  }
}

let pg: EphemeralDatabase;
let idp: FakeIdp;
let store: PgCapabilityIssueStore;
const apps: NestExpressApplication[] = [];
const stores: PgCapabilityIssueStore[] = [];
const verifier = () => new CognitoTokenVerifier({ issuer: idp.issuer, clientId: 'app-client', cooldownMs: 0 });
const alice = () => idp.users.find((u) => u.email.startsWith('alice'))!;
const issuedFor = (requestId: string) => withAdmin(pg.adminUrl, async (c) => (await c.query(`SELECT outcome, reason, tenant_id, sub FROM capability_issuance_log WHERE request_id = $1`, [requestId])).rows);

async function app(issuer?: CapabilityIssuerPort, extra: { membershipFromTokens?: boolean } = {}) {
  const created = await createTestApp({
    ...extra,
    postgresUrl: pg.appUrl,
    ownerUrl: pg.adminUrl,
    tokenVerifier: verifier(),
    controllers: [CapabilityProbe],
    ...(issuer ? { overrides: [{ provide: CapabilityIssuerPort, useValue: issuer }] } : {}),
  });
  apps.push(created);
  holder.database = created.get(Database);
  return created;
}
const who = async (a: NestExpressApplication, requestId: string) => {
  const res = await request(a.getHttpServer()).get('/api/v1/probe-capability/who').set(bearer(await idp.mintAccessToken({ user: alice() }))).set('X-Request-Id', requestId).expect(200);
  return res.body as Seen;
};

beforeAll(async () => {
  pg = await createEphemeralDatabase();
  idp = await startFakeIdp({ clientId: 'app-client' });
  store = new PgCapabilityIssueStore({ url: pg.issuerUrl, ssl: 'disable' });
});
afterAll(async () => {
  for (const a of apps) await a.close();
  for (const extra of stores) await extra.close();
  await store?.close();
  await idp?.stop();
  await pg?.drop();
});

describe('with an issuer: one capability per request', () => {
  it('asks once, and every transaction of the request (organization work too) carries that capability, which the database accepts', async () => {
    const counting = new Counting(new IssuerCore(verifier(), store));
    const a = await app(counting);
    const before = holder.database!.capabilityStats();
    const seen = await who(a, 'req-cap-e2e-0001');

    expect(counting.calls).toBe(1);
    expect(seen.caps[0]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(seen.caps[1]).toBe(seen.caps[0]);
    expect(seen.org).toBe(seen.caps[0]);
    expect(seen.tenants).toEqual(['alpha', 'alpha']);
    expect(seen.mismatch).toEqual([null, null]); // a valid capability for alpha is bound: naming another tenant resolves to nobody
    expect(await issuedFor('req-cap-e2e-0001')).toEqual([{ outcome: 'issued', reason: null, tenant_id: 'alpha', sub: alice().sub }]);

    const after = holder.database!.capabilityStats();
    expect(after.bound - before.bound).toBe(4); // the three transactions of the request AND the guard's own membership lookup, which now runs under the capability
    expect(after.missing - before.missing).toBe(0); // nothing is exempt from the count
  });

  it('a second request is a second issuance, not a reuse of the first one\'s capability', async () => {
    const counting = new Counting(new IssuerCore(verifier(), store));
    const a = await app(counting);
    const first = await who(a, 'req-cap-e2e-0002');
    const second = await who(a, 'req-cap-e2e-0003');
    expect(counting.calls).toBe(2);
    expect(second.caps[0]).not.toBe(first.caps[0]);
    expect(await issuedFor('req-cap-e2e-0002')).toHaveLength(1);
    expect(await issuedFor('req-cap-e2e-0003')).toHaveLength(1);
  });

  it('a public route asks for nothing', async () => {
    const counting = new Counting(new IssuerCore(verifier(), store));
    const a = await app(counting);
    await request(a.getHttpServer()).get('/api/v1/probe-capability/open').expect(200);
    expect(counting.calls).toBe(0);
  });

  it('a refused token never reaches the issuer', async () => {
    const counting = new Counting(new IssuerCore(verifier(), store));
    const a = await app(counting);
    await request(a.getHttpServer()).get('/api/v1/probe-capability/who').set(bearer(await idp.mintAccessToken({ user: alice(), signWith: 'foreign' }))).expect(401);
    expect(counting.calls).toBe(0);
  });
});

describe('without a working issuer the request goes on as today, and is counted', () => {
  it('no issuer configured (the default): no capability, "not-configured"', async () => {
    const a = await app();
    const before = holder.database!.capabilityStats();
    const seen = await who(a, 'req-cap-e2e-0004');
    expect(seen.caps).toEqual([null, null]);
    expect(seen.org).toBeNull();
    expect(seen.tenants).toEqual(['alpha', 'alpha']); // guc mode: the setting still binds, exactly as before this slice
    const after = holder.database!.capabilityStats();
    expect(after.missing - before.missing).toBe(4); // the guard's lookup is counted with the rest
    expect(after.byReason['not-configured']! - (before.byReason['not-configured'] ?? 0)).toBe(4);
    expect(await issuedFor('req-cap-e2e-0004')).toEqual([]);
  });

  it('an issuer that is down: the request succeeds, and the reason is "issuer-unavailable"', async () => {
    const unreachable = new PgCapabilityIssueStore({ url: pg.issuerUrl.replace(/:[^:@/]+@/, ':wrong@'), ssl: 'disable' });
    stores.push(unreachable);
    const down = new Counting(new IssuerCore(verifier(), unreachable));
    const a = await app(down);
    const before = holder.database!.capabilityStats();
    const seen = await who(a, 'req-cap-e2e-0005');
    expect(down.calls).toBe(1);
    expect(seen.caps).toEqual([null, null]);
    const after = holder.database!.capabilityStats();
    expect(after.byReason['issuer-unavailable']! - (before.byReason['issuer-unavailable'] ?? 0)).toBe(4);
  });
});

/**
 * DATA-01 slice 3 PR A (A2): the guard asks for the capability FIRST, then looks the person up UNDER it. The issuer reads the current membership version
 * itself, so the guard no longer needs a capability-less lookup to learn one.
 */
describe('the capability comes before the membership lookup', () => {
  type Step = { step: 'issue'; outcome: 'issued' | 'failed' } | { step: 'tx'; capability: string | null; authorityBound: boolean };

  /** Records the order of the issuer's answer and every transaction the request opens, by watching the real `withTenant`. */
  function record(inner: CapabilityIssuerPort) {
    const steps: Step[] = [];
    const issued: string[] = [];
    const port = new (class extends CapabilityIssuerPort {
      async issue(r: CapabilityIssueRequest): Promise<IssuedCapability | undefined> {
        try {
          const result = await inner.issue(r);
          if (result) issued.push(result.token);
          steps.push({ step: 'issue', outcome: 'issued' });
          return result;
        } catch (error) {
          steps.push({ step: 'issue', outcome: 'failed' });
          throw error;
        }
      }
    })();
    const watch = (database: Database) => {
      const original = database.withTenant.bind(database);
      jest.spyOn(database, 'withTenant').mockImplementation(((...args: Parameters<Database['withTenant']>) => {
        steps.push({ step: 'tx', capability: currentRequestCapability()?.token ?? null, authorityBound: currentRequestAuthority() !== undefined });
        return original(...args);
      }) as Database['withTenant']);
    };
    return { port, steps, issued, watch };
  }

  it('with an issuer: the issuer answers first, and the lookup (the first transaction) carries the capability it returned, before any authority is bound', async () => {
    const seen = record(new IssuerCore(verifier(), store));
    const a = await app(seen.port);
    seen.watch(holder.database!);
    const before = holder.database!.capabilityStats();
    const body = await who(a, 'req-cap-order-01');
    expect(seen.steps[0]).toEqual({ step: 'issue', outcome: 'issued' });
    const transactions = seen.steps.slice(1);
    expect(transactions).toHaveLength(4); // the lookup, then the probe's three
    expect(transactions[0]).toEqual({ step: 'tx', capability: seen.issued[0], authorityBound: false }); // the lookup: under the capability, before the authority exists
    for (const tx of transactions.slice(1, 3)) expect(tx).toEqual({ step: 'tx', capability: seen.issued[0], authorityBound: true });
    expect(transactions[3]).toEqual({ step: 'tx', capability: seen.issued[0], authorityBound: false }); // the probe's organization work: the person's authority goes, the capability stays
    expect(body.caps[0]).toBe(seen.issued[0]);
    expect(holder.database!.capabilityStats().bound - before.bound).toBe(4);
    expect(await issuedFor('req-cap-order-01')).toEqual([{ outcome: 'issued', reason: null, tenant_id: 'alpha', sub: alice().sub }]);
  });

  it('control: with the issuer down the same lookup runs WITHOUT a capability, is counted with its reason, and the request still succeeds', async () => {
    const unreachable = new PgCapabilityIssueStore({ url: pg.issuerUrl.replace(/:[^:@/]+@/, ':wrong@'), ssl: 'disable' });
    stores.push(unreachable);
    const seen = record(new IssuerCore(verifier(), unreachable));
    const a = await app(seen.port);
    seen.watch(holder.database!);
    const before = holder.database!.capabilityStats();
    await who(a, 'req-cap-order-02');
    expect(seen.steps[0]).toEqual({ step: 'issue', outcome: 'failed' });
    expect(seen.steps.filter((s) => s.step === 'tx').map((s) => (s as { capability: string | null }).capability)).toEqual([null, null, null, null]);
    const after = holder.database!.capabilityStats();
    expect(after.byReason['issuer-unavailable']! - (before.byReason['issuer-unavailable'] ?? 0)).toBe(4);
  });

  it('the guard never sends a membership version: the issuer is asked for the token and the request id only', async () => {
    const asked: CapabilityIssueRequest[] = [];
    const inner = new IssuerCore(verifier(), store);
    const a = await app(new (class extends CapabilityIssuerPort {
      issue(r: CapabilityIssueRequest) {
        asked.push(r);
        return inner.issue(r);
      }
    })());
    await who(a, 'req-cap-order-03');
    expect(asked).toHaveLength(1);
    expect(Object.keys(asked[0]!).sort()).toEqual(['accessToken', 'requestId']);
  });
});

/**
 * (A3) The authority a request carries is the version the CAPABILITY was issued at. If the membership moves between the issuance and the lookup, a write
 * is refused at commit (403, and an `authority-changed` event, written under the request's still-valid capability); a read is allowed, as it always was.
 */
describe('the membership moves between the issuance and the lookup', () => {
  const bump = () => withAdmin(pg.adminUrl, (c) => c.query(`UPDATE tenant_memberships SET roles = ARRAY['clinician', 'reader'], changed_by = 'test-move' WHERE sub = $1 AND tenant_id = 'alpha'`, [alice().sub]));
  const patientsLabelled = (label: string) => withAdmin(pg.adminUrl, async (c) => (await c.query('SELECT count(*)::int AS n FROM patients WHERE label = $1', [label])).rows[0].n as number);
  const get = async (a: NestExpressApplication, route: string, requestId: string) =>
    request(a.getHttpServer()).get(`/api/v1/probe-capability/${route}`).set(bearer(await idp.mintAccessToken({ user: alice() }))).set('X-Request-Id', requestId);

  class Moving extends CapabilityIssuerPort {
    constructor(private readonly inner: CapabilityIssuerPort, private readonly move: boolean) {
      super();
    }
    async issue(r: CapabilityIssueRequest): Promise<IssuedCapability | undefined> {
      const issued = await this.inner.issue(r);
      if (this.move) await bump(); // after the database stamped the version, before the guard looks the person up
      return issued;
    }
  }

  it('no move (control): the write commits, and the capability\'s version is the one the row has', async () => {
    const a = await app(new Moving(new IssuerCore(verifier(), store), false));
    const reply = await get(a, 'write', 'req-cap-move-01');
    expect(reply.status).toBe(200);
    expect(await patientsLabelled('SYN-ORDER-req-cap-move-01')).toBe(1);
    const [row] = await withAdmin(pg.adminUrl, async (c) => (await c.query(`SELECT c.membership_version AS v, m.version AS current FROM tenant_capabilities c JOIN tenant_memberships m ON m.sub = c.sub AND m.tenant_id = c.tenant_id WHERE c.request_id = 'req-cap-move-01'`)).rows);
    expect(row.v).toBe(row.current);
  });

  it('a move after the issuance: the write is refused at commit with 403 and leaves no row; the same request\'s read is allowed', async () => {
    const a = await app(new Moving(new IssuerCore(verifier(), store), true));
    const write = await get(a, 'write', 'req-cap-move-02');
    expect(write.status).toBe(403);
    expect(await patientsLabelled('SYN-ORDER-req-cap-move-02')).toBe(0);
    const read = await get(a, 'read', 'req-cap-move-03');
    expect(read.status).toBe(200); // reads keep admission-time semantics
    const events = (await securityEventsOf(a)).filter((e) => e.requestId === 'req-cap-move-02');
    expect(events).toEqual([expect.objectContaining({ eventType: 'access.refused', subjectRef: alice().sub, details: { reason: 'authority-changed' } })]);
  });
});

/**
 * Founder decision D1=(i) (2026-10-20): an admission refusal is recorded by the issuer's `capability_issuance_log` row; the API stops writing
 * `access.refused` to security_events for those, and keeps writing it for the mid-request `authority-changed` refusal and for `token-revoked`.
 * It stops ONLY when the issuer did record the refusal: with no issuer (today's production default) or an issuer that failed, nothing else would.
 */
describe('refusal records (decision D1=(i))', () => {
  const sub = (name: string) => idp.users.find((u) => u.email.startsWith(name))!.sub;
  const refusals = async (a: NestExpressApplication, person: string) => (await securityEventsOf(a)).filter((e) => e.eventType === 'access.refused' && e.subjectRef === person).map((e) => e.details.reason);
  const logRowsFor = (person: string) => withAdmin(pg.adminUrl, async (c) => (await c.query(`SELECT outcome, reason FROM capability_issuance_log WHERE sub = $1 ORDER BY seq`, [person])).rows);
  const status = async (a: NestExpressApplication, name: string, requestId: string) =>
    (await request(a.getHttpServer()).get('/api/v1/probe-capability/read').set(bearer(await idp.mintAccessToken({ user: idp.users.find((u) => u.email.startsWith(name))! }))).set('X-Request-Id', requestId)).status;

  beforeAll(async () => {
    await withAdmin(pg.adminUrl, async (c) => {
      for (const t of ['alpha', 'beta']) await registerTenantRow(c, t);
      // carol: removed. dave: active, but his tokens are revoked. alice may exist from the mirror in earlier tests.
      // One removed person per test below: the database throttles a refusal event to one a minute per person and reason, so a shared person would let one test's event satisfy another's.
      for (const name of ['carol', 'gina', 'hal']) await c.query(`INSERT INTO tenant_memberships (tenant_id, sub, status, roles, changed_by) VALUES ('alpha', $1, 'removed', ARRAY['reader'], 'test') ON CONFLICT (tenant_id, sub) DO NOTHING`, [sub(name)]);
      await c.query(`INSERT INTO tenant_memberships (tenant_id, sub, status, roles, changed_by) VALUES ('beta', $1, 'active', ARRAY['reader'], 'test') ON CONFLICT (tenant_id, sub) DO NOTHING`, [sub('dave')]);
      await c.query(`UPDATE tenant_memberships SET tokens_valid_after = now() + interval '1 hour' WHERE sub = $1`, [sub('dave')]);
      await c.query(`INSERT INTO tenant_memberships (tenant_id, sub, status, roles, changed_by) VALUES ('alpha', $1, 'active', ARRAY['reader'], 'test') ON CONFLICT (tenant_id, sub) DO UPDATE SET status = 'active'`, [sub('alice')]);
    });
  });

  it('a removed person, with a working issuer: 403, one refused row in the issuance log, and NO access.refused event (an active person is let in, in the same run)', async () => {
    const a = await app(new IssuerCore(verifier(), store), { membershipFromTokens: false });
    expect(await status(a, 'alice', 'req-cap-d1-00')).toBe(200); // control: the same app, the same issuer, a member
    expect(await status(a, 'carol', 'req-cap-d1-01')).toBe(403);
    expect(await logRowsFor(sub('carol'))).toEqual([{ outcome: 'refused', reason: 'membership-not-current' }]);
    expect(await refusals(a, sub('carol'))).toEqual([]);
  });

  it('control: the same removed person with NO issuer configured is still recorded in security_events (nothing else would record it)', async () => {
    const a = await app(undefined, { membershipFromTokens: false });
    expect(await status(a, 'gina', 'req-cap-d1-02')).toBe(403);
    expect(await refusals(a, sub('gina'))).toEqual(['removed']);
    expect(await logRowsFor(sub('gina'))).toEqual([]); // and there is no issuance row either: this one is the only record
  });

  it('control: with an issuer that is DOWN the refusal is recorded in security_events too (the issuance log has no row to stand in for it)', async () => {
    const unreachable = new PgCapabilityIssueStore({ url: pg.issuerUrl.replace(/:[^:@/]+@/, ':wrong@'), ssl: 'disable' });
    stores.push(unreachable);
    const a = await app(new IssuerCore(verifier(), unreachable), { membershipFromTokens: false });
    expect(await status(a, 'hal', 'req-cap-d1-03')).toBe(403);
    expect(await refusals(a, sub('hal'))).toEqual(['removed']);
  });

  it('a revoked token with a working issuer: 401, and the token-revoked event is still written (that person holds a valid capability)', async () => {
    const a = await app(new IssuerCore(verifier(), store), { membershipFromTokens: false });
    expect(await status(a, 'dave', 'req-cap-d1-04')).toBe(401);
    expect(await refusals(a, sub('dave'))).toEqual(['token-revoked']);
    expect(await logRowsFor(sub('dave'))).toEqual([{ outcome: 'issued', reason: null }]);
  });
});
