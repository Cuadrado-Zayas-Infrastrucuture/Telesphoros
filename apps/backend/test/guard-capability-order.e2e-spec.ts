import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Client } from 'pg';
import request from 'supertest';
import { CapabilityIssueError, type CapabilityIssueRequest, CapabilityIssuerPort, type IssuedCapability } from '../src/issuer/capability-issuer.port';
import { MembershipRepository } from '../src/storage/membership.repository';
import { createTestApp, issuerUrlOf, membershipOf, securityEventsOf } from './helpers/app';
import { bearer, signToken } from './helpers/tokens';

/**
 * DATA-01 slice 3 PR A, at the guard, on every storage tier: the guard asks the issuer for the capability BEFORE it looks the person up, and the refusal
 * records follow decision D1=(i). The issuer here is a scripted stand-in (the real one is exercised against PostgreSQL in test/db/request-capability.pg-spec.ts),
 * so what is under test is the guard's order and its mapping of the issuer's answer, not the issuer.
 */
const TENANT = 'tenant-user-a';
const OPERATOR = { by: 'operator-test', reason: 'test' };
const person = () => `person-${randomUUID().slice(0, 8)}`;
const token = (sub: string, options: Parameters<typeof signToken>[0] = {}) => signToken({ sub, tenant: TENANT, ...options });
const CAPABILITY = 'C'.repeat(43);

class ScriptedIssuer extends CapabilityIssuerPort {
  readonly asked: CapabilityIssueRequest[] = [];
  trace: string[] = [];
  /** The issuer login's URL when the app runs on PostgreSQL. Then the default answer is a real row minted through the database's own function. */
  issuerUrl?: string;
  behave: (request: CapabilityIssueRequest) => Promise<IssuedCapability | undefined> = async (request) =>
    (this.issuerUrl ? this.mint(request, this.issuerUrl) : { token: CAPABILITY, expiresAt: new Date(Date.now() + 60_000), membershipVersion: 1 });
  async issue(r: CapabilityIssueRequest): Promise<IssuedCapability | undefined> {
    this.asked.push(r);
    this.trace.push('issue');
    return this.behave(r);
  }
  /**
   * A capability the database knows: the database's membership check (FR-007) refuses any capability it has no row for, so a stand-in string is
   * only valid without PostgreSQL. The tenant and person come from the access token's own claims.
   */
  private async mint(r: CapabilityIssueRequest, url: string): Promise<IssuedCapability> {
    const claims = JSON.parse(Buffer.from(r.accessToken.split('.')[1]!, 'base64url').toString()) as { sub: string; tenant: string };
    const value = randomBytes(32).toString('base64url');
    const client = new Client({ connectionString: url });
    await client.connect();
    try {
      const { rows } = await client.query<{ expires_at: Date; refusal: string | null; membership_version: string | null }>(
        'SELECT * FROM tenant_capability_issue_current($1, $2, $3, $4, $5)',
        [claims.tenant, claims.sub, 'request', createHash('sha256').update(value, 'utf8').digest(), r.requestId],
      );
      const row = rows[0]!;
      if (row.refusal) throw new CapabilityIssueError('refused', row.refusal);
      return { token: value, expiresAt: row.expires_at, membershipVersion: Number(row.membership_version) };
    } finally {
      await client.end();
    }
  }
}

let app: NestExpressApplication;
const issuer = new ScriptedIssuer();
/** The answer the issuer gives when no test is overriding it (set once the database is known). */
let defaultBehave: ScriptedIssuer['behave'];
const api = () => request(app.getHttpServer());
const reasons = async (sub: string) => (await securityEventsOf(app)).filter((e) => e.eventType === 'access.refused' && e.subjectRef === sub).map((e) => e.details.reason);
const me = async (sub: string, options: Parameters<typeof signToken>[0] = {}) => api().get('/api/v1/me').set(bearer(await token(sub, options)));
const refuse = (detail: string) => async () => {
  throw new CapabilityIssueError('refused', detail);
};

beforeAll(async () => {
  app = await createTestApp({ membershipFromTokens: false, overrides: [{ provide: CapabilityIssuerPort, useValue: issuer }] });
  issuer.issuerUrl = issuerUrlOf(app);
  defaultBehave = issuer.behave;
  const memberships = app.get(MembershipRepository);
  const find = memberships.find.bind(memberships);
  jest.spyOn(memberships, 'find').mockImplementation(async (tenantId, sub) => {
    issuer.trace.push('find');
    return find(tenantId, sub);
  });
});
afterAll(async () => {
  await app.close();
});
beforeEach(() => {
  issuer.asked.length = 0;
  issuer.trace = [];
});

describe('the order', () => {
  it('the issuer is asked before the membership is read, once, with the access token and the request id only', async () => {
    const sub = person();
    await membershipOf(app).grant({ tenantId: TENANT, sub, roles: ['reader'], ...OPERATOR });
    const res = await api().get('/api/v1/me').set(bearer(await token(sub))).set('X-Request-Id', 'req-order-0001');
    expect(res.status).toBe(200);
    expect(issuer.trace).toEqual(['issue', 'find']);
    expect(issuer.asked).toHaveLength(1);
    expect(Object.keys(issuer.asked[0]!).sort()).toEqual(['accessToken', 'requestId']);
    expect(issuer.asked[0]!.requestId).toBe('req-order-0001');
  });

  it('control: an issuer that fails does not stop the lookup, and the person is still let in', async () => {
    const sub = person();
    await membershipOf(app).grant({ tenantId: TENANT, sub, roles: ['reader'], ...OPERATOR });
    issuer.behave = async () => {
      throw new CapabilityIssueError('unavailable');
    };
    try {
      expect((await me(sub)).status).toBe(200);
      expect(issuer.trace).toEqual(['issue', 'find']);
    } finally {
      issuer.behave = defaultBehave;
    }
  });
});

describe('refusal records (decision D1=(i)): the issuer\'s log row stands in only for what it recorded', () => {
  const withBehaviour = async (behave: ScriptedIssuer['behave'], run: () => Promise<void>) => {
    issuer.behave = behave;
    try {
      await run();
    } finally {
      issuer.behave = defaultBehave;
    }
  };

  it('a person the issuer refused as not current (removed, unknown) is refused 403 and writes no access.refused event', async () => {
    const removed = person();
    const stranger = person();
    const member = person();
    const ops = membershipOf(app);
    await ops.grant({ tenantId: TENANT, sub: removed, roles: ['reader'], ...OPERATOR });
    await ops.remove({ tenantId: TENANT, sub: removed, ...OPERATOR });
    await ops.grant({ tenantId: TENANT, sub: member, roles: ['reader'], ...OPERATOR });
    await withBehaviour(refuse('membership-not-current'), async () => {
      expect((await me(removed)).status).toBe(403);
      expect((await me(stranger)).status).toBe(403);
      expect(await reasons(removed)).toEqual([]);
      expect(await reasons(stranger)).toEqual([]);
    });
    // control, same app and person: with no issuer answer to stand in for it, the event IS written
    await withBehaviour(refuse('rate-limited'), async () => {
      expect((await me(removed)).status).toBe(403);
      expect(await reasons(removed)).toEqual(['removed']);
    });
    expect((await me(member)).status).toBe(200); // and a member is still admitted
  });

  it('a suspended organization the issuer refused as inactive writes no event either', async () => {
    const sub = person();
    const ops = membershipOf(app);
    await ops.grant({ tenantId: TENANT, sub, roles: ['reader'], ...OPERATOR });
    await withBehaviour(refuse('tenant-inactive'), async () => {
      // the issuer says "inactive"; the lookup still decides the status. Here the organization is active, so the person is let in: nothing to record.
      expect((await me(sub)).status).toBe(200);
      expect(await reasons(sub)).toEqual([]);
    });
  });

  it.each([
    ['invalid-token', undefined],
    ['no-tenant', undefined],
    ['unavailable', undefined],
    ['refused', 'rate-limited'],
    ['refused', 'malformed'],
  ] as const)('an issuer answer of %s %s did not record the refusal, so the event is still written', async (reason, detail) => {
    const sub = person();
    await withBehaviour(async () => {
      throw new CapabilityIssueError(reason, detail);
    }, async () => {
      expect((await me(sub)).status).toBe(403); // no membership
      expect(await reasons(sub)).toEqual(['no-membership']);
    });
  });

  it('no issuer configured: the event is written, exactly as before', async () => {
    const sub = person();
    await withBehaviour(async () => undefined, async () => {
      expect((await me(sub)).status).toBe(403);
      expect(await reasons(sub)).toEqual(['no-membership']);
    });
  });

  it('a revoked token is still recorded when the issuer issued: that person holds a valid capability', async () => {
    const sub = person();
    const ops = membershipOf(app);
    await ops.grant({ tenantId: TENANT, sub, roles: ['reader'], ...OPERATOR });
    const old = await token(sub, { iat: -30 });
    await ops.remove({ tenantId: TENANT, sub, revokedAt: new Date(Date.now() - 20_000), ...OPERATOR });
    await ops.grant({ tenantId: TENANT, sub, roles: ['reader'], revokedAt: new Date(Date.now() - 10_000), ...OPERATOR });
    expect((await api().get('/api/v1/me').set(bearer(old))).status).toBe(401);
    expect(await reasons(sub)).toEqual(['token-revoked']);
  });
});
