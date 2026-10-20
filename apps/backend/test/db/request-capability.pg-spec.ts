import { Controller, Get, Req } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { type FakeIdp, startFakeIdp } from '@telesphoros/fake-idp';
import type { Request } from 'express';
import request from 'supertest';
import { asOrganizationWork } from '../../src/auth/authority-context';
import { CognitoTokenVerifier } from '../../src/auth/cognito-token-verifier';
import { Public } from '../../src/auth/decorators';
import { Database } from '../../src/db/database';
import { CapabilityIssuerPort, type CapabilityIssueRequest, type IssuedCapability } from '../../src/issuer/capability-issuer.port';
import { IssuerCore, PgCapabilityIssueStore } from '../../src/issuer/issuer-core';
import { createTestApp } from '../helpers/app';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';
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

async function app(issuer?: CapabilityIssuerPort) {
  const created = await createTestApp({
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
    expect(after.bound - before.bound).toBe(3); // the three transactions of the request
    expect(after.missing - before.missing).toBe(0); // and the guard's own membership lookup is not counted
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
    expect(after.missing - before.missing).toBe(3);
    expect(after.byReason['not-configured']! - (before.byReason['not-configured'] ?? 0)).toBe(3);
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
    expect(after.byReason['issuer-unavailable']! - (before.byReason['issuer-unavailable'] ?? 0)).toBe(3);
  });
});
