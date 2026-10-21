import { Logger } from '@nestjs/common';
import { type FakeIdp, startFakeIdp } from '@telesphoros/fake-idp';
import type { Request, Response } from 'express';
import { Client } from 'pg';
import { authorityContextMiddleware, capabilityAbsentReason, currentRequestCapability } from '../../src/auth/authority-context';
import { CAPABILITY_TOKEN_PATTERN, CapabilityIssueError } from '../../src/issuer/capability-issuer.port';
import { startIssuer, type RunningIssuer } from '../../src/issuer/issuer-app';
import { loadIssuerEnv } from '../../src/issuer/issuer-env';
import { HttpCapabilityIssuer } from '../../src/issuer/issuer-http-client';
import { IssuerLogger } from '../../src/issuer/issuer-log';
import { RequestCapabilities } from '../../src/issuer/request-capabilities';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';
import { registerTenantRow } from '../helpers/membership';

/**
 * DATA-01 PR B, end to end: the API's HTTP client against the REAL issuer process (the node:http server, the real `CognitoTokenVerifier` against the fake
 * identity provider, and the issuer's own database login), minus the container and the Service Connect proxy between them. Whatever the client returns is
 * then used the way the API uses it: the capability resolves to the person's organization through the APPLICATION's login. Each refusal is followed by the
 * success control, because a refusal means something only on a server that issues.
 */
jest.setTimeout(60_000);

let db: EphemeralDatabase;
let idp: FakeIdp;
let issuer: RunningIssuer | undefined;
let broken: RunningIssuer | undefined;
const issuerLines: string[] = [];
const minted: string[] = [];
const presented: string[] = [];

/** One logger serves the issuer and the client in this process; the API's own lines are the ones written under the client's contexts. */
const apiLines = () => issuerLines.filter((l) => /\[(IssuerClient|RequestCapabilities)\]/.test(l));
const owner = <T>(work: (c: Client) => Promise<T>) => withAdmin(db.adminUrl, work);
const user = (name: string) => idp.users.find((u) => u.email.startsWith(name))!;
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
const envFor = (databaseUrl: string) => ({
  NODE_ENV: 'development', DATABASE_URL: databaseUrl, DATABASE_SSL: 'disable', COGNITO_ISSUER: idp.issuer, COGNITO_APP_CLIENT_ID: 'app-client',
});
const clientTo = (running: RunningIssuer, over: { timeoutMs?: number } = {}) => new HttpCapabilityIssuer({ baseUrl: `http://127.0.0.1:${running.port}`, retryPauseMs: 5, ...over });
async function present(who: string, options: { signWith?: 'foreign' } = {}) {
  const token = await idp.mintAccessToken({ user: user(who), ...options });
  presented.push(token);
  return token;
}
async function ask(client: HttpCapabilityIssuer, requestId: string, over: { who?: string; accessToken?: string } = {}) {
  const who = over.who ?? 'alice';
  const issued = await client.issue({ accessToken: over.accessToken ?? (await present(who)), requestId });
  if (issued) minted.push(issued.token);
  return issued;
}
async function refusal(client: HttpCapabilityIssuer, requestId: string, over: { who?: string; accessToken?: string } = {}): Promise<CapabilityIssueError> {
  try {
    await ask(client, requestId, over);
  } catch (error) {
    expect(error).toBeInstanceOf(CapabilityIssueError);
    return error as CapabilityIssueError;
  }
  throw new Error('expected the issuer to refuse');
}

beforeAll(async () => {
  Logger.overrideLogger(new IssuerLogger((line) => issuerLines.push(line)));
  db = await createEphemeralDatabase();
  idp = await startFakeIdp({ clientId: 'app-client' });
  await owner(async (c) => {
    for (const tenant of ['alpha', 'beta']) await registerTenantRow(c, tenant);
    for (const [tenant, name, status] of [['alpha', 'alice', 'active'], ['beta', 'bob', 'active'], ['alpha', 'carol', 'removed']] as const) {
      await c.query(`INSERT INTO tenant_memberships (tenant_id, sub, status, roles, changed_by) VALUES ($1, $2, $3, ARRAY['clinician'], 'test')`, [tenant, user(name).sub, status]);
    }
  });
  issuer = await startIssuer(loadIssuerEnv(envFor(db.issuerUrl)), { host: '127.0.0.1', port: 0 });
  broken = await startIssuer(loadIssuerEnv(envFor(db.issuerUrl.replace(/:[^:@/]+@/, ':wrong-password-4c1d@'))), { host: '127.0.0.1', port: 0 });
});
afterAll(async () => {
  Logger.overrideLogger(['log', 'error', 'warn']);
  await issuer?.stop(1000).catch(() => undefined);
  await broken?.stop(1000).catch(() => undefined);
  await idp?.stop();
  await db?.drop();
});

describe('the positive control: the client asks the real issuer and gets a capability the database honours', () => {
  it('issues for two real people, each capability resolves to their own organization through the application login, and a stranger\'s token resolves to nobody', async () => {
    const client = clientTo(issuer!);
    const alice = await ask(client, 'req-cli-ok-01');
    expect(alice!.token).toMatch(CAPABILITY_TOKEN_PATTERN);
    expect(alice!.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(alice!.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 61_000); // 60 s, D1
    expect(alice!.membershipVersion).toBe(await versionOf(user('alice').sub)); // the version the DATABASE read: the request named none
    expect(await logRows('req-cli-ok-01')).toEqual([{ outcome: 'issued', reason: null, tenant_id: 'alpha' }]);
    expect(await appTenantFor(alice!.token)).toBe('alpha');
    expect(await appTenantFor('A'.repeat(43))).toBeNull();
    const bob = await ask(client, 'req-cli-ok-02', { who: 'bob' });
    expect(await appTenantFor(bob!.token)).toBe('beta');
  });

  it('through RequestCapabilities, the way the guard calls it: the request\'s slot holds the capability and nothing is recorded as absent', async () => {
    const capabilities = new RequestCapabilities(clientTo(issuer!));
    const access = await present('alice');
    const version = await versionOf(user('alice').sub);
    let outcome: unknown;
    let bound: string | undefined;
    let absent: string | undefined = 'untouched';
    await new Promise<void>((resolve, reject) => {
      authorityContextMiddleware({ id: 'req-cli-guard-01' } as unknown as Request, {} as Response, () => {
        capabilities
          .obtain({ accessToken: access, requestId: 'req-cli-guard-01' })
          .then((result) => {
            outcome = result;
            bound = currentRequestCapability()?.token;
            absent = capabilityAbsentReason();
          })
          .then(resolve, reject);
      });
    });
    expect(outcome).toEqual({ status: 'bound', membershipVersion: version }); // what the guard now learns from asking
    expect(bound).toMatch(CAPABILITY_TOKEN_PATTERN);
    expect(absent).toBeUndefined();
    minted.push(bound!);
    expect(await appTenantFor(bound!)).toBe('alpha');
  });
});

describe('refusals reach the caller as the same closed reasons, each followed by the control', () => {
  it('a removed member is refused with the database\'s code, and no capability exists', async () => {
    const client = clientTo(issuer!);
    const error = await refusal(client, 'req-cli-refused-01', { who: 'carol' });
    expect([error.reason, error.detail]).toEqual(['refused', 'membership-not-current']);
    expect(await capabilityRows('req-cli-refused-01')).toBe(0);
    expect((await logRows('req-cli-refused-01'))).toEqual([{ outcome: 'refused', reason: 'membership-not-current', tenant_id: 'alpha' }]);
    expect(await ask(client, 'req-cli-refused-02')).toBeDefined();
  });

  it('a token signed by a key the pool never published is invalid-token, and the database is not touched', async () => {
    const client = clientTo(issuer!);
    const error = await refusal(client, 'req-cli-forged-01', { accessToken: await present('alice', { signWith: 'foreign' }) });
    expect([error.reason, error.detail]).toEqual(['invalid-token', undefined]);
    expect(await logRows('req-cli-forged-01')).toEqual([]);
    expect(await ask(client, 'req-cli-forged-02')).toBeDefined();
  });

  it('a genuine token for a person with no organization is no-tenant (not refused: the two 403s are told apart)', async () => {
    const client = clientTo(issuer!);
    const error = await refusal(client, 'req-cli-notenant-01', { who: 'erin' });
    expect([error.reason, error.detail]).toEqual(['no-tenant', undefined]);
    expect(await ask(client, 'req-cli-notenant-02')).toBeDefined();
  });

  it('a request id the issuer will not take is invalid-request, and is not retried (one attempt, no row)', async () => {
    const client = clientTo(issuer!);
    const error = await refusal(client, 'has a space and is not allowed');
    expect([error.reason, error.detail]).toEqual(['invalid-request', undefined]);
    expect(await ask(client, 'req-cli-badid-02')).toBeDefined();
  });
});

describe('the issuer fails closed when its database does, and the client says so', () => {
  it('a login the database refuses is unavailable at the client (after its one retry), with no password, token or address anywhere on the API side', async () => {
    const access = await present('alice');
    const client = clientTo(broken!);
    const alarmed = () => issuerLines.filter((l) => l.includes('Capability not issued: unavailable')).length;
    const before = alarmed();
    const started = Date.now();
    let caught: unknown;
    try {
      await client.issue({ accessToken: access, requestId: 'req-cli-down-01' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CapabilityIssueError);
    expect((caught as CapabilityIssueError).reason).toBe('unavailable');
    expect((caught as CapabilityIssueError).detail).toBe('server');
    expect(Date.now() - started).toBeLessThan(2600);
    expect(alarmed() - before).toBe(2); // the issuer counted both attempts (one per ask); the API side wrote no alarm phrase of its own; the API logged none of this
    expect(apiLines().some((l) => l.endsWith('Issuer call retried: server'))).toBe(true); // control: the client did log its retry, so the checks below look at something
    const apiSide = JSON.stringify([(caught as Error).message, (caught as CapabilityIssueError).detail, (caught as Error).stack, apiLines()]);
    for (const secret of ['wrong-password-4c1d', access, '127.0.0.1', String(broken!.port)]) expect(apiSide).not.toContain(secret);
    expect(await ask(clientTo(issuer!), 'req-cli-down-02')).toBeDefined(); // control: the good issuer is unaffected
  });

  it('an issuer that has stopped is unavailable (network), and RequestCapabilities records it as the reason without failing the request', async () => {
    const second = await startIssuer(loadIssuerEnv(envFor(db.issuerUrl)), { host: '127.0.0.1', port: 0 });
    const client = clientTo(second);
    expect(await ask(client, 'req-cli-stop-01')).toBeDefined(); // control: it issued before it stopped
    await second.stop(1000);
    const capabilities = new RequestCapabilities(client);
    let absent: string | undefined;
    await new Promise<void>((resolve, reject) => {
      authorityContextMiddleware({ id: 'req-cli-stop-02' } as unknown as Request, {} as Response, () => {
        capabilities
          .obtain({ accessToken: 'opaque', requestId: 'req-cli-stop-02' })
          .then(() => {
            absent = capabilityAbsentReason();
          })
          .then(resolve, reject);
      });
    });
    expect(absent).toBe('issuer-unavailable');
  });
});

describe('no token anywhere on the API side', () => {
  it('no API-side line (the client\'s and RequestCapabilities\') carries the alarm phrase, a capability or an access token', async () => {
    expect(minted.length).toBeGreaterThanOrEqual(6);
    expect(presented.length).toBeGreaterThanOrEqual(8);
    expect(issuerLines.some((l) => l.includes('Capability not issued'))).toBe(true); // control: the capture saw the issuer's lines
    const apiText = apiLines().join('\n');
    expect(apiText.length).toBeGreaterThan(0); // control: the API side did write lines
    expect(apiText).not.toContain('Capability not issued:');
    for (const token of minted) expect(apiText).not.toContain(token);
    for (const access of presented) expect(apiText).not.toContain(access);
    for (const line of issuerLines) if (line.includes('Capability not issued:')) expect(line).not.toMatch(/\[(IssuerClient|RequestCapabilities)\]/);
  });
});
