import { randomBytes, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { Database } from '../../src/db/database';
import { startIssuer, type RunningIssuer } from '../../src/issuer/issuer-app';
import { loadIssuerEnv } from '../../src/issuer/issuer-env';
import { MAX_CLOCK_SKEW_MS, signWorkerRequest } from '../../src/issuer/worker-signature';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';
import { queuedEvaluation } from '../helpers/queued-evaluation';

/**
 * Spec 012 slice 2: the issuer serves a job capability to a worker that signs its request (plan D1), and a signed request is accepted once across every
 * issuer task, because the nonce is claimed in the database (founder, 2026-10-29). Two real issuer processes share one database here, as two tasks do behind
 * the load balancer. The positive control comes first; a refusal means something only on an issuer that issues.
 */
jest.setTimeout(60_000);

const PATH = '/v1/job-capabilities';
const key = randomBytes(32);
let pg: EphemeralDatabase;
let database: Database;
let first: RunningIssuer;
let second: RunningIssuer;
let keyless: RunningIssuer;

const env = (extra: Record<string, string> = {}) =>
  loadIssuerEnv({
    NODE_ENV: 'development',
    DATABASE_URL: pg.issuerUrl,
    DATABASE_SSL: 'disable',
    COGNITO_ISSUER: 'http://127.0.0.1:9/syn-unused-issuer',
    COGNITO_APP_CLIENT_ID: 'syn-client',
    ...extra,
  });

beforeAll(async () => {
  pg = await createEphemeralDatabase();
  database = new Database({ url: pg.appUrl, ssl: 'disable' });
  const withKey = env({ ISSUER_WORKER_KEY: key.toString('base64url') });
  first = await startIssuer(withKey, { host: '127.0.0.1', port: 0 });
  second = await startIssuer(withKey, { host: '127.0.0.1', port: 0 });
  keyless = await startIssuer(env(), { host: '127.0.0.1', port: 0 });
}, 60_000);
afterAll(async () => {
  for (const running of [first, second, keyless]) await running?.stop(1000);
  await database?.onModuleDestroy();
  await pg?.drop();
});

const owner = <T>(work: (c: Client) => Promise<T>) => withAdmin(pg.adminUrl, work);

/** A signed request, as the worker will send it; `headers` and `body` can be kept and sent again. */
function signedRequest(input: { jobId: string; workerId: string }, options: { signWith?: Buffer; timestamp?: number } = {}) {
  const body = Buffer.from(JSON.stringify({ ...input, requestId: `req-${randomUUID()}` }));
  const headers = signWorkerRequest({ key: options.signWith ?? key, method: 'POST', path: PATH, body, timestamp: options.timestamp ?? Date.now() });
  return { body, headers: { 'content-type': 'application/json', ...headers } as Record<string, string> };
}

async function send(running: RunningIssuer, request: { body: Buffer; headers: Record<string, string> }) {
  const response = await fetch(`http://127.0.0.1:${running.port}${PATH}`, { method: 'POST', headers: request.headers, body: request.body });
  const text = await response.text();
  return { status: response.status, text, json: JSON.parse(text) as Record<string, unknown> };
}

const capabilities = (job: string) => owner(async (c) => Number((await c.query('SELECT count(*) AS n FROM tenant_capabilities WHERE request_id = $1', [job])).rows[0].n));

/** What the application login's database sees with this capability: the organization and the person it names. */
async function boundBy(token: string, tenantId: string) {
  const c = new Client({ connectionString: pg.appUrl });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.capability', $1, true), set_config('app.current_tenant_id', $2, true)`, [token, tenantId]);
    return (await c.query<{ tenant: string | null; actor: string | null }>('SELECT app_tenant() AS tenant, app_actor() AS actor')).rows[0]!;
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    await c.end();
  }
}

describe('POST /v1/job-capabilities', () => {
  it('issues a capability for the requester to a signed worker that holds the job, and the database binds it (control)', async () => {
    const t = await queuedEvaluation(pg, database);
    const answer = await send(first, signedRequest({ jobId: t.job, workerId: t.worker }));
    expect(answer.status).toBe(200);
    expect(answer.json).toMatchObject({ tenantId: t.tenantId, sub: t.sub, membershipVersion: 1 });
    expect(answer.json.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await boundBy(answer.json.token as string, t.tenantId)).toEqual({ tenant: t.tenantId, actor: t.sub });
  });

  it('accepts a signed request once: the same request sent again is refused by the same task and by another task', async () => {
    const t = await queuedEvaluation(pg, database);
    const request = signedRequest({ jobId: t.job, workerId: t.worker });
    expect((await send(first, request)).status).toBe(200);
    for (const running of [first, second]) {
      const again = await send(running, request);
      expect(again).toMatchObject({ status: 401, json: { error: 'replayed' } });
    }
    expect(await capabilities(t.job)).toBe(1);
    expect((await send(second, signedRequest({ jobId: t.job, workerId: t.worker }))).status).toBe(200); // a fresh request is fine
  });

  it.each([
    ['no signature', (r: ReturnType<typeof signedRequest>) => ({ ...r, headers: { 'content-type': 'application/json' } })],
    ['another key', (r: ReturnType<typeof signedRequest>) => ({ ...r, headers: signedRequest(JSON.parse(r.body.toString()), { signWith: randomBytes(32) }).headers })],
    [
      'a body changed after signing',
      (r: ReturnType<typeof signedRequest>) => ({ ...r, body: Buffer.from(r.body.toString().replace(/"workerId":"[^"]+"/, '"workerId":"syn-worker-other"')) }),
    ],
    ['a stale timestamp', (r: ReturnType<typeof signedRequest>) => signedRequest(JSON.parse(r.body.toString()), { timestamp: Date.now() - 2 * MAX_CLOCK_SKEW_MS })],
  ])('refuses %s before reading anything, and issues nothing', async (_case, change) => {
    const t = await queuedEvaluation(pg, database);
    const refused = change(signedRequest({ jobId: t.job, workerId: t.worker }));
    const answer = await send(first, refused);
    expect(answer).toMatchObject({ status: 401, json: { error: 'unauthenticated' } });
    expect(await capabilities(t.job)).toBe(0);
    expect(await owner(async (c) => Number((await c.query('SELECT count(*) AS n FROM capability_issuance_log WHERE request_id = $1', [t.job])).rows[0].n))).toBe(0);
    expect(answer.text).not.toContain(key.toString('base64url'));
    if (refused.headers['x-telesphoros-signature']) expect(answer.text).not.toContain(refused.headers['x-telesphoros-signature']);
  });

  it("passes on the database's refusal code when the worker does not hold the job", async () => {
    const t = await queuedEvaluation(pg, database);
    const answer = await send(first, signedRequest({ jobId: t.job, workerId: 'syn-worker-other' }));
    expect(answer).toMatchObject({ status: 403, json: { error: 'refused', detail: 'job-not-held' } });
    expect(await capabilities(t.job)).toBe(0);
  });

  it('refuses a signed body that is not a job-capability request', async () => {
    const body = Buffer.from(JSON.stringify({ jobId: 'not-a-uuid', workerId: 'syn-worker-1', requestId: 'req-1' }));
    const headers = signWorkerRequest({ key, method: 'POST', path: PATH, body, timestamp: Date.now() });
    expect(await send(first, { body, headers: { 'content-type': 'application/json', ...headers } })).toMatchObject({ status: 400, json: { error: 'invalid-request' } });
  });

  it('does not exist on an issuer started without a worker key', async () => {
    const t = await queuedEvaluation(pg, database);
    expect(await send(keyless, signedRequest({ jobId: t.job, workerId: t.worker }))).toMatchObject({ status: 404, json: { error: 'not-found' } });
    expect(await capabilities(t.job)).toBe(0);
  });
});

describe('issuer_nonce_claim', () => {
  const claimAs = async (url: string, caller: string, nonce: string) => {
    const c = new Client({ connectionString: url });
    await c.connect();
    try {
      return (await c.query<{ claimed: boolean }>('SELECT issuer_nonce_claim($1, $2) AS claimed', [caller, nonce])).rows[0]!.claimed;
    } finally {
      await c.end();
    }
  };

  it('accepts a nonce once per caller, as the issuer login', async () => {
    const nonce = randomBytes(24).toString('base64url');
    expect(await claimAs(pg.issuerUrl, 'evaluation-worker', nonce)).toBe(true);
    expect(await claimAs(pg.issuerUrl, 'evaluation-worker', nonce)).toBe(false);
    expect(await claimAs(pg.issuerUrl, 'syn-other-caller', nonce)).toBe(true);
  });

  it('forgets a nonce once it is older than any request the issuer accepts', async () => {
    const nonce = randomBytes(24).toString('base64url');
    expect(await claimAs(pg.issuerUrl, 'evaluation-worker', nonce)).toBe(true);
    await owner((c) => c.query(`UPDATE issuer_request_nonces SET seen_at = seen_at - interval '1 hour' WHERE nonce = $1`, [nonce]));
    expect(await claimAs(pg.issuerUrl, 'evaluation-worker', randomBytes(24).toString('base64url'))).toBe(true); // a claim sweeps the old ones
    expect(await owner(async (c) => Number((await c.query('SELECT count(*) AS n FROM issuer_request_nonces WHERE nonce = $1', [nonce])).rows[0].n))).toBe(0);
  });

  it.each([
    ['the application login', () => pg.appUrl],
    ['the queue worker login', () => pg.workerUrl],
  ])('cannot be called by %s', async (_case, url) => {
    const attempt = claimAs(url(), 'evaluation-worker', randomBytes(24).toString('base64url')).then(
      () => 'ok',
      (e: { code?: string }) => e.code,
    );
    expect(await attempt).toBe('42501');
  });

  it.each([
    ['no caller', null, randomBytes(24).toString('base64url')],
    ['no nonce', 'evaluation-worker', null],
    ['a nonce too long to be one', 'evaluation-worker', 'n'.repeat(200)],
  ])('refuses %s', async (_case, caller, nonce) => {
    const attempt = claimAs(pg.issuerUrl, caller as string, nonce as string).then(
      (claimed) => claimed,
      (e: { code?: string }) => e.code,
    );
    expect(await attempt).toBe(false);
  });
});
