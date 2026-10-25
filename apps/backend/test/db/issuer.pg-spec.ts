import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { type FakeIdp, startFakeIdp } from '@telesphoros/fake-idp';
import { Client } from 'pg';
import { CognitoTokenVerifier } from '../../src/auth/cognito-token-verifier';
import { CapabilityIssueError } from '../../src/issuer/capability-issuer.port';
import { IssuerCore, PgCapabilityIssueStore } from '../../src/issuer/issuer-core';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';
import { registerTenantRow } from '../helpers/membership';

/**
 * DATA-01 T014 (SC-006): an issuance leaves exactly one row in the issuance log and none of its rows, and none of the process's log output, holds
 * the raw token. The issuer here is the real core on the real issuer login, with the real verifier against the fake identity provider.
 *
 * The log (`capability_issuance_log`) is what migration 0028's issue function writes for every attempt; it is not `security_audit_events`, and the
 * function never writes there. The capability table holds the token's sha256 by design, so the "no hash" check applies to the log only.
 */
jest.setTimeout(60_000);

let db: EphemeralDatabase;
let idp: FakeIdp;
let store: PgCapabilityIssueStore;
let core: IssuerCore;
const captured: string[] = [];
const minted: string[] = [];
/** Every access token this file sends to the issuer, through any path, accepted or refused. */
const presented: string[] = [];
const present = async (user: ReturnType<typeof idp.users.find>, options: { signWith?: 'foreign' } = {}) => {
  const token = await idp.mintAccessToken({ user: user!, ...options });
  presented.push(token);
  return token;
};

const owner = <T>(work: (c: Client) => Promise<T>) => withAdmin(db.adminUrl, work);
const user = (name: string) => idp.users.find((u) => u.email.startsWith(name))!;
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest();
const logRows = (requestId: string) =>
  owner(async (c) => (await c.query(`SELECT *, row_to_json(l)::text AS whole FROM capability_issuance_log l WHERE request_id = $1 ORDER BY seq`, [requestId])).rows);
const versionOf = (sub: string) => owner(async (c) => Number((await c.query('SELECT version FROM tenant_memberships WHERE sub = $1', [sub])).rows[0].version));
const everything = () => captured.join('');

async function issue(over: { who?: string; requestId: string; accessToken?: string }) {
  const who = user(over.who ?? 'alice');
  const issued = await core.issue({ accessToken: over.accessToken ?? (await present(who)), requestId: over.requestId });
  minted.push(issued!.token);
  return issued!;
}
/** What the application login makes of a token: the organization it names, or null. */
const appTenantFor = async (token: string) => {
  const c = new Client({ connectionString: db.appUrl });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.capability', $1, true)`, [token]);
    return (await c.query<{ t: string | null }>('SELECT app_tenant() AS t')).rows[0]!.t;
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    await c.end();
  }
};

beforeAll(async () => {
  // Every level on, and every write to the process's output captured, so "the token is in no log line" is measured against something that does log.
  Logger.overrideLogger(['log', 'error', 'warn', 'debug', 'verbose']);
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream) as (...a: unknown[]) => boolean;
    jest.spyOn(stream, 'write').mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
      captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'));
      return write(chunk, ...rest);
    }) as typeof stream.write);
  }
  db = await createEphemeralDatabase();
  idp = await startFakeIdp({ clientId: 'app-client' });
  await owner(async (c) => {
    for (const tenant of ['alpha', 'beta']) await registerTenantRow(c, tenant);
    for (const [tenant, name, status] of [
      ['alpha', 'alice', 'active'],
      ['beta', 'bob', 'active'],
      ['alpha', 'carol', 'removed'],
    ] as const) {
      await c.query(`INSERT INTO tenant_memberships (tenant_id, sub, status, roles, changed_by) VALUES ($1, $2, $3, ARRAY['clinician'], 'test')`, [tenant, user(name).sub, status]);
    }
  });
  store = new PgCapabilityIssueStore({ url: db.issuerUrl, ssl: 'disable' });
  core = new IssuerCore(new CognitoTokenVerifier({ issuer: idp.issuer, clientId: 'app-client', cooldownMs: 0 }), store);
});
afterAll(async () => {
  jest.restoreAllMocks();
  await store?.close();
  await idp?.stop();
  await db?.drop();
});

describe('the log capture itself (a positive control for every "not in the logs" claim below)', () => {
  it('sees a line the process logs', () => {
    new Logger('Marker').warn('marker-line-7f3a');
    expect(everything()).toContain('marker-line-7f3a');
  });
});

describe('one issuance, one row, no token (SC-006)', () => {
  it('writes exactly one "issued" row, stores only the hash, and holds the token in no row and no log line', async () => {
    const before = await owner(async (c) => (await c.query('SELECT count(*)::int AS n FROM capability_issuance_log')).rows[0].n);
    const issued = await issue({ requestId: 'req-issuer-ok-01' });

    const rows = await logRows('req-issuer-ok-01');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tenant_id: 'alpha', sub: user('alice').sub, purpose: 'request', outcome: 'issued', reason: null });
    expect(await owner(async (c) => (await c.query('SELECT count(*)::int AS n FROM capability_issuance_log')).rows[0].n)).toBe(before + 1);

    const stored = await owner(async (c) => (await c.query(`SELECT *, row_to_json(t)::text AS whole FROM tenant_capabilities t WHERE request_id = $1`, ['req-issuer-ok-01'])).rows);
    expect(stored).toHaveLength(1);
    expect(stored[0].token_hash).toEqual(sha256(issued.token));
    expect(stored[0].whole).not.toContain(issued.token);
    expect(rows[0].whole).not.toContain(issued.token);
    expect(rows[0].whole.toLowerCase()).not.toContain(sha256(issued.token).toString('hex'));
    expect(everything()).not.toContain(issued.token);
  });

  it("the token it returned is the one the database resolves (control), and a stranger's is not", async () => {
    const issued = await issue({ requestId: 'req-issuer-ok-02' });
    expect(await appTenantFor(issued.token)).toBe('alpha');
    expect(await appTenantFor('A'.repeat(43))).toBeNull();
    const other = await issue({ who: 'bob', requestId: 'req-issuer-ok-03' });
    expect(await appTenantFor(other.token)).toBe('beta');
  });

  it('returns the version the database read, and it moves with the membership (the caller never names one)', async () => {
    const first = await issue({ requestId: 'req-issuer-version-01' });
    expect(first.membershipVersion).toBe(await versionOf(user('alice').sub));
    await owner((c) => c.query(`UPDATE tenant_memberships SET roles = ARRAY['reader'], changed_by = 'test' WHERE sub = $1`, [user('alice').sub]));
    const second = await issue({ requestId: 'req-issuer-version-02' });
    expect(second.membershipVersion).toBe(first.membershipVersion + 1);
    expect(second.membershipVersion).toBe(await versionOf(user('alice').sub));
    expect((await logRows('req-issuer-version-02'))[0]).toMatchObject({ membership_version: String(second.membershipVersion) });
  });

  it('a removed member is refused as one row with a closed reason and no capability, and an active member is issued in the same run (control)', async () => {
    const error = await core.issue({ accessToken: await present(user('carol')), requestId: 'req-issuer-refused-01' }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(CapabilityIssueError);
    expect(error).toMatchObject({ reason: 'refused', detail: 'membership-not-current' });
    const rows = await logRows('req-issuer-refused-01');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'refused', reason: 'membership-not-current', tenant_id: 'alpha' });
    expect(await owner(async (c) => (await c.query(`SELECT count(*)::int AS n FROM tenant_capabilities WHERE request_id = $1`, ['req-issuer-refused-01'])).rows[0].n)).toBe(0);
    expect(everything()).toContain('membership-not-current'); // the issuer does say why it refused, and the capture sees it
    expect((await issue({ requestId: 'req-issuer-refused-02' })).token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('a token the verifier refuses reaches the database as nothing at all: no row', async () => {
    const before = await owner(async (c) => (await c.query('SELECT count(*)::int AS n FROM capability_issuance_log')).rows[0].n);
    const forged = await present(user('alice'), { signWith: 'foreign' });
    await expect(core.issue({ accessToken: forged, requestId: 'req-issuer-forged-1' })).rejects.toMatchObject({ reason: 'invalid-token' });
    expect(await logRows('req-issuer-forged-1')).toHaveLength(0);
    expect(await owner(async (c) => (await c.query('SELECT count(*)::int AS n FROM capability_issuance_log')).rows[0].n)).toBe(before);
    await issue({ requestId: 'req-issuer-forged-2' }); // control: a valid one adds exactly one
    expect(await owner(async (c) => (await c.query('SELECT count(*)::int AS n FROM capability_issuance_log')).rows[0].n)).toBe(before + 1);
  });

  it('no raw token, and no access token, appears in any log line the process wrote during all of the above', async () => {
    expect(minted.length).toBeGreaterThanOrEqual(4);
    for (const token of minted) expect(everything()).not.toContain(token);
    await issue({ requestId: 'req-issuer-ok-04', accessToken: await present(user('alice')) });
    expect(presented.length).toBeGreaterThanOrEqual(4); // accepted, refused by the database, refused by the verifier
    for (const access of presented) {
      expect(everything()).not.toContain(access);
      expect(everything()).not.toContain(access.split('.')[1]!); // nor its claims
    }
  });
});

describe('the issuer fails closed when its database does', () => {
  it('answers "unavailable" for a database it cannot reach, and logs neither token nor password', async () => {
    const broken = new PgCapabilityIssueStore({ url: db.issuerUrl.replace(/:[^:@/]+@/, ':wrong-password-9d41@'), ssl: 'disable' });
    try {
      const failing = new IssuerCore(new CognitoTokenVerifier({ issuer: idp.issuer, clientId: 'app-client', cooldownMs: 0 }), broken);
      const access = await present(user('alice'));
      await expect(failing.issue({ accessToken: access, requestId: 'req-issuer-down-01' })).rejects.toMatchObject({ reason: 'unavailable' });
      expect(everything()).not.toContain('wrong-password-9d41');
      expect(everything()).not.toContain(access);
    } finally {
      await broken.close();
    }
  });
});
