import { Logger } from '@nestjs/common';
import { type FakeIdp, startFakeIdp } from '@telesphoros/fake-idp';
import { Client } from 'pg';
import { startIssuer, type RunningIssuer } from '../../src/issuer/issuer-app';
import { loadIssuerEnv } from '../../src/issuer/issuer-env';
import { IssuerLogger } from '../../src/issuer/issuer-log';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';
import { registerTenantRow } from '../helpers/membership';

/**
 * DATA-01 PR A: the issuer process, as the Terraform task runs it, minus the container. Settings come through the issuer's own environment loader, the server
 * is the real node:http server, the verifier is the real `CognitoTokenVerifier` against the fake identity provider, and the database door is the real issuer
 * login (`telesphoros_session_issuer`). The positive control comes first and again after each refusal: a refusal means something only on a server that
 * issues.
 */
jest.setTimeout(60_000);

let db: EphemeralDatabase;
let idp: FakeIdp;
let issuer: RunningIssuer | undefined;
let broken: RunningIssuer | undefined;
const lines: string[] = [];
const written: string[] = [];
const minted: string[] = [];
const presented: string[] = [];

const owner = <T>(work: (c: Client) => Promise<T>) => withAdmin(db.adminUrl, work);
const user = (name: string) => idp.users.find((u) => u.email.startsWith(name))!;
const everything = () => [...lines, ...written].join('\n');
const envFor = (databaseUrl: string) => ({
  NODE_ENV: 'development', DATABASE_URL: databaseUrl, DATABASE_SSL: 'disable', COGNITO_ISSUER: idp.issuer, COGNITO_APP_CLIENT_ID: 'app-client',
});
const versionOf = (sub: string) => owner(async (c) => Number((await c.query('SELECT version FROM tenant_memberships WHERE sub = $1', [sub])).rows[0].version));
const logRows = (requestId: string) => owner(async (c) => (await c.query('SELECT outcome, reason, tenant_id FROM capability_issuance_log WHERE request_id = $1 ORDER BY seq', [requestId])).rows);
const capabilityRows = (requestId: string) => owner(async (c) => Number((await c.query('SELECT count(*) AS n FROM tenant_capabilities WHERE request_id = $1', [requestId])).rows[0].n));
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

async function call(running: RunningIssuer, body: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }) {
  const response = await fetch(`http://127.0.0.1:${running.port}/v1/capabilities`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: response.status, text: await response.text() };
}
async function present(who: string, options: { signWith?: 'foreign' } = {}) {
  const token = await idp.mintAccessToken({ user: user(who), ...options });
  presented.push(token);
  return token;
}
async function ask(running: RunningIssuer, requestId: string, over: { who?: string; version?: number; accessToken?: string } = {}) {
  const who = over.who ?? 'alice';
  const reply = await call(running, { accessToken: over.accessToken ?? (await present(who)), membershipVersion: over.version ?? (await versionOf(user(who).sub)), requestId });
  const parsed = JSON.parse(reply.text) as Record<string, string>;
  if (typeof parsed.token === 'string') minted.push(parsed.token);
  return { status: reply.status, body: parsed, text: reply.text };
}

beforeAll(async () => {
  Logger.overrideLogger(new IssuerLogger((line) => lines.push(line)));
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream) as (...a: unknown[]) => boolean;
    jest.spyOn(stream, 'write').mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
      written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'));
      return write(chunk, ...rest);
    }) as typeof stream.write);
  }
  db = await createEphemeralDatabase();
  idp = await startFakeIdp({ clientId: 'app-client' });
  await owner(async (c) => {
    for (const tenant of ['alpha', 'beta']) await registerTenantRow(c, tenant);
    for (const [tenant, name] of [['alpha', 'alice'], ['beta', 'bob']] as const) {
      await c.query(`INSERT INTO tenant_memberships (tenant_id, sub, status, roles, changed_by) VALUES ($1, $2, 'active', ARRAY['clinician'], 'test')`, [tenant, user(name).sub]);
    }
  });
  issuer = await startIssuer(loadIssuerEnv(envFor(db.issuerUrl)), { host: '127.0.0.1', port: 0 });
  broken = await startIssuer(loadIssuerEnv(envFor(db.issuerUrl.replace(/:[^:@/]+@/, ':wrong-password-4c1d@'))), { host: '127.0.0.1', port: 0 });
});
afterAll(async () => {
  jest.restoreAllMocks();
  Logger.overrideLogger(['log', 'error', 'warn']);
  await issuer?.stop(1000).catch(() => undefined);
  await broken?.stop(1000).catch(() => undefined);
  await idp?.stop();
  await db?.drop();
});

describe('the positive control', () => {
  it('answers the health check, issues for a real person, and the token it returns resolves to their organization through the application login', async () => {
    const live = await fetch(`http://127.0.0.1:${issuer!.port}/livez`);
    expect(live.status).toBe(200);
    const reply = await ask(issuer!, 'req-srv-ok-01');
    expect(reply.status).toBe(200);
    expect(Object.keys(reply.body).sort()).toEqual(['expiresAt', 'token']);
    expect(reply.body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new Date(reply.body.expiresAt!).getTime()).toBeGreaterThan(Date.now());
    expect(await logRows('req-srv-ok-01')).toEqual([{ outcome: 'issued', reason: null, tenant_id: 'alpha' }]);
    expect(await appTenantFor(reply.body.token!)).toBe('alpha');
    expect(await appTenantFor('A'.repeat(43))).toBeNull(); // a stranger's token is nobody's
    const other = await ask(issuer!, 'req-srv-ok-02', { who: 'bob' });
    expect(await appTenantFor(other.body.token!)).toBe('beta');
  });

  it('connects as the issuer login and as nothing else', async () => {
    const users = await owner(async (c) => (await c.query(`SELECT DISTINCT usename FROM pg_stat_activity WHERE application_name = 'telesphoros-session-issuer' AND datname = current_database()`)).rows.map((r) => r.usename));
    const loginOf = (url: string) => decodeURIComponent(new URL(url).username);
    expect(loginOf(db.issuerUrl)).not.toBe(loginOf(db.appUrl)); // control: the two logins differ, so the next line can tell them apart
    expect(users).toEqual([loginOf(db.issuerUrl)]);
  });
});

describe('refusals through the real server, each followed by the control', () => {
  it('a membership that moved since the API read it: 403 refused, with the database\'s code, one log row, no capability, and the alarm phrase once', async () => {
    const stale = (await versionOf(user('alice').sub)) + 5;
    const before = lines.filter((l) => l.includes('Capability not issued: refused (membership-not-current)')).length;
    const reply = await ask(issuer!, 'req-srv-refused-01', { version: stale });
    expect(reply.status).toBe(403);
    expect(reply.body).toEqual({ error: 'refused', detail: 'membership-not-current' });
    expect(await logRows('req-srv-refused-01')).toEqual([{ outcome: 'refused', reason: 'membership-not-current', tenant_id: 'alpha' }]);
    expect(await capabilityRows('req-srv-refused-01')).toBe(0);
    expect(lines.filter((l) => l.includes('Capability not issued: refused (membership-not-current)')).length).toBe(before + 1);
    expect((await ask(issuer!, 'req-srv-refused-02')).status).toBe(200);
  });

  it('a token signed by a key the pool never published: 401, and the database is not touched', async () => {
    const forged = await present('alice', { signWith: 'foreign' });
    const reply = await ask(issuer!, 'req-srv-forged-01', { accessToken: forged });
    expect(reply.status).toBe(401);
    expect(reply.body).toEqual({ error: 'invalid-token' });
    expect(await logRows('req-srv-forged-01')).toEqual([]);
    expect((await ask(issuer!, 'req-srv-forged-02')).status).toBe(200);
  });

  it('a genuine token for a user who belongs to no tenant: 403 no-tenant, and the database is not touched', async () => {
    const reply = await ask(issuer!, 'req-srv-notenant-01', { who: 'erin', version: 1 });
    expect(reply.status).toBe(403);
    expect(reply.body).toEqual({ error: 'no-tenant' });
    expect(await logRows('req-srv-notenant-01')).toEqual([]);
    expect((await ask(issuer!, 'req-srv-notenant-02')).status).toBe(200);
  });

  it('a request the server refuses on its shape never reaches the verifier or the database', async () => {
    const before = await owner(async (c) => Number((await c.query('SELECT count(*) AS n FROM capability_issuance_log')).rows[0].n));
    expect((await call(issuer!, { accessToken: await present('alice'), membershipVersion: 1, requestId: 'req-srv-shape-01', tenant: 'beta' })).status).toBe(400);
    expect((await call(issuer!, { accessToken: await present('alice'), membershipVersion: 1, requestId: 'req-srv-shape-02' }, { 'content-type': 'text/plain' })).status).toBe(415);
    expect(await owner(async (c) => Number((await c.query('SELECT count(*) AS n FROM capability_issuance_log')).rows[0].n))).toBe(before);
    expect((await ask(issuer!, 'req-srv-shape-03')).status).toBe(200);
  });
});

describe('the issuer fails closed when its database does', () => {
  it('answers 503 for a login the database refuses, once in the log under the alarm phrase, with no password, token or address in the answer or the log', async () => {
    const before = lines.filter((l) => l.includes('Capability not issued: unavailable')).length;
    const access = await present('alice');
    const reply = await call(broken!, { accessToken: access, membershipVersion: 1, requestId: 'req-srv-down-01' });
    expect(reply.status).toBe(503);
    expect(JSON.parse(reply.text)).toEqual({ error: 'unavailable' });
    expect(lines.filter((l) => l.includes('Capability not issued: unavailable')).length).toBe(before + 1);
    for (const secret of ['wrong-password-4c1d', access, '127.0.0.1:5']) {
      expect(reply.text).not.toContain(secret);
    }
    expect(everything()).not.toContain('wrong-password-4c1d');
    expect(everything()).not.toContain(access);
    expect((await ask(issuer!, 'req-srv-down-02')).status).toBe(200); // control: the good issuer is unaffected
  });
});

describe('no token anywhere', () => {
  it('no capability the server issued, and no access token it was shown or its claims, is in any log line or any byte written to stdout or stderr', async () => {
    expect(minted.length).toBeGreaterThanOrEqual(5);
    expect(presented.length).toBeGreaterThanOrEqual(8);
    expect(everything().length).toBeGreaterThan(0); // control: the capture saw output
    expect(lines.some((l) => l.includes('Capability not issued'))).toBe(true);
    for (const token of minted) expect(everything()).not.toContain(token);
    for (const access of presented) {
      expect(everything()).not.toContain(access);
      expect(everything()).not.toContain(access.split('.')[1]!);
    }
  });
});

describe('stopping', () => {
  it('stops accepting, closes its pool, and the database sees no session of its own left', async () => {
    const sessions = () => owner(async (c) => Number((await c.query(`SELECT count(*) AS n FROM pg_stat_activity WHERE application_name = 'telesphoros-session-issuer' AND datname = current_database()`)).rows[0].n));
    expect(await sessions()).toBeGreaterThan(0); // control: it had a session
    const port = issuer!.port;
    await issuer!.stop(2000);
    issuer = undefined;
    await expect(fetch(`http://127.0.0.1:${port}/livez`)).rejects.toThrow();
    let left = await sessions();
    for (let i = 0; i < 20 && left > 0; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      left = await sessions();
    }
    expect(left).toBe(0);
  });
});
