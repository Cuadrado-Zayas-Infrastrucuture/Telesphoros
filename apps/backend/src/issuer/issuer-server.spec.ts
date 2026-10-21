import { request as httpRequest, type Server } from 'node:http';
import { connect } from 'node:net';
import { Logger } from '@nestjs/common';
import { type FakeIdp, startFakeIdp } from '@telesphoros/fake-idp';
import { CognitoTokenVerifier } from '../auth/cognito-token-verifier';
import { CapabilityIssueError, type CapabilityIssueFailure, type CapabilityIssueRequest, CapabilityIssuerPort, type IssuedCapability } from './capability-issuer.port';
import { type CapabilityIssueStore, type IssueCall, IssuerCore } from './issuer-core';
import { IssuerLogger } from './issuer-log';
import { createIssuerServer, drainServer, MAX_BODY_BYTES } from './issuer-server';

/**
 * DATA-01 PR A: the issuer's HTTP face. Plain node:http, one route that does anything (POST /v1/capabilities), one for the container's health check
 * (GET /livez), and a closed table from the core's failure reasons to status codes. Every rejection test also asserts the port was never called, and is paired
 * with a positive control in the same run, so "never called" means the request was refused and not that the port is dead.
 */
const validBody = { accessToken: 'opaque-access-token-sentinel', requestId: 'req-http-0001' };
const EXPIRES = new Date('2030-01-01T00:00:00.000Z');
const TOKEN = 'T'.repeat(43);

class StubPort extends CapabilityIssuerPort {
  readonly calls: CapabilityIssueRequest[] = [];
  behave: () => Promise<IssuedCapability | undefined> = async () => ({ token: TOKEN, expiresAt: EXPIRES, membershipVersion: 7 });
  async issue(request: CapabilityIssueRequest) {
    this.calls.push(request);
    return this.behave();
  }
}

interface Reply { status: number; headers: Record<string, string | string[] | undefined>; body: string }
let servers: Server[] = [];
const lines: string[] = [];

async function start(port: CapabilityIssuerPort, limits?: Parameters<typeof createIssuerServer>[1]): Promise<{ server: Server; port: number }> {
  const server = createIssuerServer(port, limits);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return { server, port: (server.address() as { port: number }).port };
}

function send(port: number, options: { method?: string; path?: string; headers?: Record<string, string>; body?: string | Buffer; chunks?: Buffer[] }): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method: options.method ?? 'POST', path: options.path ?? '/v1/capabilities', headers: options.headers, agent: false }, (res) => {
      const parts: Buffer[] = [];
      res.on('data', (c: Buffer) => parts.push(c));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(parts).toString('utf8') }));
    });
    req.on('error', reject);
    if (options.chunks) for (const chunk of options.chunks) req.write(chunk);
    else if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}
const post = (port: number, body: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }) =>
  send(port, { headers, body: typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body) });
const json = (reply: Reply) => JSON.parse(reply.body) as Record<string, unknown>;

beforeEach(() => {
  lines.length = 0;
  Logger.overrideLogger(new IssuerLogger((line) => lines.push(line)));
});
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => { s.closeAllConnections(); s.close(() => resolve()); })));
  servers = [];
});
afterAll(() => Logger.overrideLogger(['log', 'error', 'warn']));

describe('POST /v1/capabilities: the positive control', () => {
  it('passes exactly the two fields to the port and answers 200 with token, expiry and the version the capability was issued at', async () => {
    const port = new StubPort();
    const { port: p } = await start(port);
    const reply = await post(p, validBody);
    expect(reply.status).toBe(200);
    expect(json(reply)).toEqual({ token: TOKEN, expiresAt: '2030-01-01T00:00:00.000Z', membershipVersion: 7 });
    expect(port.calls).toEqual([validBody]);
    expect(reply.headers['content-type']).toMatch(/^application\/json/);
    expect(reply.headers['cache-control']).toBe('no-store');
    expect(reply.headers.connection).toBe('close'); // no connection is kept open for reuse
  });

  it('accepts a charset on the content type, and the largest body the fields allow (a 4096-character token)', async () => {
    const port = new StubPort();
    const { port: p } = await start(port);
    expect((await post(p, validBody, { 'content-type': 'application/json; charset=utf-8' })).status).toBe(200);
    expect((await post(p, { ...validBody, accessToken: 'a'.repeat(4096) })).status).toBe(200);
    expect(port.calls).toHaveLength(2);
  });

  it('reads a body of exactly the 8 KiB cap (the fields then refuse it, 400) and refuses one byte more before reading on (413)', async () => {
    const port = new StubPort();
    const { port: p } = await start(port);
    const body = (bytes: number) => ' '.repeat(bytes - Buffer.byteLength(JSON.stringify(validBody))) + JSON.stringify(validBody);
    const atCap = body(MAX_BODY_BYTES);
    expect(Buffer.byteLength(atCap)).toBe(MAX_BODY_BYTES);
    expect((await post(p, atCap)).status).toBe(200); // whitespace is padding: still exactly the three fields, so it is accepted
    const over = body(MAX_BODY_BYTES + 1);
    expect((await post(p, over)).status).toBe(413);
    expect((await send(p, { headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' }, chunks: [Buffer.from(over.slice(0, 4096)), Buffer.from(over.slice(4096))] }).catch(() => ({ status: 413 }))).status).toBe(413);
    expect(port.calls).toHaveLength(1);
  });
});

describe('the closed table from failure reasons to status codes', () => {
  const table: [CapabilityIssueFailure, number][] = [['invalid-token', 401], ['no-tenant', 403], ['invalid-request', 400], ['refused', 403], ['unavailable', 503]];
  for (const [reason, status] of table) {
    it(`${reason} is ${status}, and the body holds the reason and nothing else`, async () => {
      const port = new StubPort();
      port.behave = async () => { throw new CapabilityIssueError(reason); };
      const { port: p } = await start(port);
      const reply = await post(p, validBody);
      expect(reply.status).toBe(status);
      expect(json(reply)).toEqual({ error: reason });
      expect(port.calls).toHaveLength(1);
    });
  }

  it('a refusal carries the database\'s closed code as detail, and only a closed code', async () => {
    const port = new StubPort();
    const { port: p } = await start(port);
    port.behave = async () => { throw new CapabilityIssueError('refused', 'rate-limited'); };
    const ok = await post(p, validBody);
    expect(ok.status).toBe(403);
    expect(json(ok)).toEqual({ error: 'refused', detail: 'rate-limited' });
    for (const detail of ['membership not current for 10.0.0.5', 'password=hunter2', 'A'.repeat(200), '', 'Upper_Case']) {
      port.behave = async () => { throw new CapabilityIssueError('refused', detail); };
      const reply = await post(p, validBody);
      expect(reply.status).toBe(403);
      expect(json(reply)).toEqual({ error: 'refused' });
      if (detail) expect(reply.body).not.toContain(detail);
    }
  });

  it('anything else the port throws is a 503 "unavailable" and its message reaches neither the caller nor the log', async () => {
    const port = new StubPort();
    port.behave = async () => { throw new Error('connect ECONNREFUSED 10.9.8.7:5432 password=sentinel-db-secret'); };
    const { port: p } = await start(port);
    const reply = await post(p, validBody);
    expect(reply.status).toBe(503);
    expect(json(reply)).toEqual({ error: 'unavailable' });
    expect(reply.body).not.toContain('10.9.8.7');
    expect(lines.join('\n')).not.toContain('sentinel-db-secret');
    expect(lines.join('\n')).not.toContain('10.9.8.7');
    expect(lines.join('\n')).toContain('unexpected'); // it is logged, by code
  });

  it('a port that returns no capability (the null issuer) is a 503, never a 200 with nothing', async () => {
    const port = new StubPort();
    port.behave = async () => undefined;
    const { port: p } = await start(port);
    expect((await post(p, validBody)).status).toBe(503);
  });
});

describe('what is refused before the port is asked', () => {
  const bad: [string, unknown, number][] = [
    ['malformed JSON', '{"accessToken":', 400],
    ['an empty body', '', 400],
    ['a JSON array', '[]', 400],
    ['JSON null', 'null', 400],
    ['a JSON string', '"x"', 400],
    ['an extra key', { ...validBody, tenant: 'beta' }, 400],
    ['a missing accessToken', { requestId: 'r' }, 400],
    ['a missing requestId', { accessToken: 'a' }, 400],
    ['a numeric accessToken', { ...validBody, accessToken: 123 }, 400],
    ['an empty accessToken', { ...validBody, accessToken: '' }, 400],
    ['a membershipVersion from a caller (the database reads it; a client that still sends one is refused, not trusted)', { ...validBody, membershipVersion: 7 }, 400],
    ['a membershipVersion sent as text', { ...validBody, membershipVersion: '7' }, 400],
    ['a requestId with a space', { ...validBody, requestId: 'req 1' }, 400],
    ['a requestId with a newline', { ...validBody, requestId: 'req\nforged' }, 400],
    ['a requestId of 129 characters', { ...validBody, requestId: 'r'.repeat(129) }, 400],
    ['an accessToken longer than any real one', { ...validBody, accessToken: 'a'.repeat(4097) }, 400],
  ];
  for (const [name, body, status] of bad) {
    it(`${name}: ${status}, port not called`, async () => {
      const port = new StubPort();
      const { port: p } = await start(port);
      const reply = await post(p, body);
      expect(reply.status).toBe(status);
      expect(json(reply)).toEqual({ error: 'invalid-request' });
      expect(port.calls).toHaveLength(0);
      expect((await post(p, validBody)).status).toBe(200); // control: the same server, a valid body
      expect(port.calls).toHaveLength(1);
    });
  }

  it('only application/json: 415, port not called', async () => {
    const port = new StubPort();
    const { port: p } = await start(port);
    const wrong: Record<string, string>[] = [{ 'content-type': 'text/plain' }, {}, { 'content-type': 'application/jsonx' }, { 'content-type': 'application/x-www-form-urlencoded' }, { 'content-type': 'multipart/form-data; boundary=x' }];
    for (const headers of wrong) {
      const reply = await post(p, validBody, headers);
      expect(reply.status).toBe(415);
      expect(json(reply)).toEqual({ error: 'unsupported-media-type' });
    }
    expect(port.calls).toHaveLength(0);
    expect((await post(p, validBody)).status).toBe(200);
  });

  it('a body over 8 KiB is 413 by Content-Length, and by chunks with no length, and the port is not called', async () => {
    expect(MAX_BODY_BYTES).toBe(8192);
    const port = new StubPort();
    const { port: p } = await start(port);
    const big = JSON.stringify({ ...validBody, accessToken: 'a'.repeat(MAX_BODY_BYTES) });
    const counted = await post(p, big);
    expect(counted.status).toBe(413);
    expect(json(counted)).toEqual({ error: 'payload-too-large' });
    const chunked = await send(p, { headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' }, chunks: [Buffer.alloc(4096, 0x61), Buffer.alloc(4096, 0x61), Buffer.alloc(16, 0x61)] }).catch(() => ({ status: 413 }));
    expect(chunked.status).toBe(413);
    expect(port.calls).toHaveLength(0);
    expect((await post(p, validBody)).status).toBe(200);
  });
});

describe('routing: everything else is 404', () => {
  it('answers 200 on GET /livez, and 404 on every other method, path and query', async () => {
    const port = new StubPort();
    const { port: p } = await start(port);
    const live = await send(p, { method: 'GET', path: '/livez' });
    expect(live.status).toBe(200);
    expect(json(live)).toEqual({ status: 'ok' });
    for (const [method, path] of [['POST', '/livez'], ['GET', '/v1/capabilities'], ['PUT', '/v1/capabilities'], ['DELETE', '/v1/capabilities'], ['POST', '/v1/capabilities?x=1'], ['POST', '/v1/capabilities/'], ['POST', '/v1/capabilities/extra'], ['POST', '/'], ['GET', '/'], ['GET', '/readyz'], ['GET', '/livez?x=1'], ['HEAD', '/livez'], ['OPTIONS', '/v1/capabilities'], ['POST', '/V1/CAPABILITIES']] as const) {
      const reply = await send(p, { method, path, headers: { 'content-type': 'application/json' }, ...(method === 'POST' || method === 'PUT' ? { body: JSON.stringify(validBody) } : {}) });
      expect([method, path, reply.status]).toEqual([method, path, 404]);
    }
    expect(port.calls).toHaveLength(0);
    expect((await post(p, validBody)).status).toBe(200); // control
  });
});

describe('time limits, connection limits and the drain', () => {
  it('closes a connection that sends its headers too slowly, and one that sends the body too slowly, without calling the port', async () => {
    const port = new StubPort();
    const { port: p } = await start(port, { headersTimeoutMs: 300, requestTimeoutMs: 600, checkIntervalMs: 100 });
    const closed = (bytes: string) =>
      new Promise<number>((resolve, reject) => {
        const started = Date.now();
        const socket = connect(p, '127.0.0.1', () => socket.write(bytes));
        socket.on('close', () => resolve(Date.now() - started));
        socket.on('error', () => undefined);
        socket.resume(); // read what the server sends, or the close is never seen
        setTimeout(() => { socket.destroy(); reject(new Error('the server kept a slow connection open')); }, 5000).unref();
      });
    expect(await closed('POST /v1/capabilities HTTP/1.1\r\nHost: x\r\n')).toBeLessThan(4000); // headers never finish
    expect(await closed('POST /v1/capabilities HTTP/1.1\r\nHost: x\r\ncontent-type: application/json\r\ncontent-length: 100\r\n\r\n{"acc')).toBeLessThan(4000); // body never finishes
    expect(port.calls).toHaveLength(0);
    expect((await post(p, validBody)).status).toBe(200);
  });

  it('sets the limits the Terraform task and the brief name', async () => {
    const { server } = await start(new StubPort());
    expect(server.headersTimeout).toBe(5000);
    expect(server.requestTimeout).toBe(10_000);
    expect(server.maxConnections).toBe(128);
    expect(server.maxRequestsPerSocket).toBe(1);
    expect(server.keepAliveTimeout).toBeLessThanOrEqual(5000);
  });

  it('drains: a request in flight finishes, new connections are refused, and the drain then ends', async () => {
    const port = new StubPort();
    let release!: () => void;
    port.behave = () => new Promise((resolve) => { release = () => resolve({ token: TOKEN, expiresAt: EXPIRES, membershipVersion: 7 }); });
    const { server, port: p } = await start(port);
    const inFlight = post(p, validBody);
    while (port.calls.length === 0) await new Promise((r) => setTimeout(r, 10));
    const draining = drainServer(server, 5000);
    await new Promise((r) => setTimeout(r, 50));
    await expect(send(p, { method: 'GET', path: '/livez' })).rejects.toThrow(); // new connection: refused
    let finished = false;
    void draining.then(() => { finished = true; });
    await new Promise((r) => setTimeout(r, 100));
    expect(finished).toBe(false); // it waits for the request in flight
    release();
    expect((await inFlight).status).toBe(200);
    await draining;
    expect(finished).toBe(true);
  });

  it('stops waiting after the grace period and cuts a request that will not finish', async () => {
    const port = new StubPort();
    port.behave = () => new Promise(() => undefined); // never answers
    const { server, port: p } = await start(port);
    const stuck = post(p, validBody).then(() => 'answered', () => 'cut');
    while (port.calls.length === 0) await new Promise((r) => setTimeout(r, 10));
    const started = Date.now();
    await drainServer(server, 300);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(await stuck).toBe('cut');
  });
});

describe('with the real core: what reaches the log, and what reaches the caller', () => {
  let idp: FakeIdp;
  class Store implements CapabilityIssueStore {
    outcome: { expiresAt: Date | null; refusal: string | null; membershipVersion: number | null } | Error = { expiresAt: EXPIRES, refusal: null, membershipVersion: 3 };
    calls: IssueCall[] = [];
    async issue(call: IssueCall) {
      this.calls.push(call);
      if (this.outcome instanceof Error) throw this.outcome;
      return this.outcome;
    }
  }
  beforeAll(async () => { idp = await startFakeIdp({ clientId: 'app-client' }); });
  afterAll(() => idp.stop());
  const alice = () => idp.users.find((u) => u.email.startsWith('alice'))!;
  const real = (store: Store) => new IssuerCore(new CognitoTokenVerifier({ issuer: idp.issuer, clientId: 'app-client', cooldownMs: 0 }), store);
  const log = () => lines.join('\n');

  it('issues for a valid token (control) and the raw capability is in the response only, never in a log line', async () => {
    const store = new Store();
    const { port: p } = await start(real(store));
    const access = await idp.mintAccessToken({ user: alice() });
    const reply = await post(p, { accessToken: access, requestId: 'req-real-ok' });
    expect(reply.status).toBe(200);
    const { token, membershipVersion } = json(reply) as { token: string; membershipVersion: number };
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(membershipVersion).toBe(3); // the store's (the database's) answer, passed to the caller
    expect(store.calls).toHaveLength(1);
    expect(log()).not.toContain(token);
    expect(log()).not.toContain(access);
  });

  it('an invalid token is 401 and the log holds the reason and the request id, not the token or its claims', async () => {
    const store = new Store();
    const { port: p } = await start(real(store));
    const forged = await idp.mintAccessToken({ user: alice(), signWith: 'foreign' });
    const reply = await post(p, { accessToken: forged, requestId: 'req-real-bad' });
    expect(reply.status).toBe(401);
    expect(reply.body).not.toContain(forged);
    expect(store.calls).toHaveLength(0);
    expect(log()).toContain('Capability not issued: invalid-token request=req-real-bad');
    expect(log()).not.toContain(forged);
    expect(log()).not.toContain(forged.split('.')[1]!);
  });

  it('a user with no tenant is 403 no-tenant', async () => {
    const { port: p } = await start(real(new Store()));
    const access = await idp.mintAccessToken({ user: idp.users.find((u) => u.email.startsWith('erin'))! });
    const reply = await post(p, { accessToken: access, requestId: 'req-real-nt' });
    expect(reply.status).toBe(403);
    expect(json(reply)).toEqual({ error: 'no-tenant' });
  });

  it('the rate-limited phrase the alarm matches reaches the log exactly once per refusal, and the server adds no second copy', async () => {
    const store = new Store();
    store.outcome = { expiresAt: null, refusal: 'rate-limited', membershipVersion: null };
    const { port: p } = await start(real(store));
    const reply = await post(p, { accessToken: await idp.mintAccessToken({ user: alice() }), requestId: 'req-real-rl' });
    expect(reply.status).toBe(403);
    expect(json(reply)).toEqual({ error: 'refused', detail: 'rate-limited' });
    expect(lines.filter((l) => l.includes('Capability not issued: refused (rate-limited)'))).toHaveLength(1);
    expect(lines.filter((l) => l.includes('Capability not issued'))).toHaveLength(1);
  });

  it('the unavailable phrase the alarm matches reaches the log exactly once, with the database\'s message nowhere', async () => {
    const store = new Store();
    store.outcome = new Error('password authentication failed for user "telesphoros_session_issuer" at 10.4.4.4 sentinel-pw');
    const { port: p } = await start(real(store));
    const access = await idp.mintAccessToken({ user: alice() });
    const reply = await post(p, { accessToken: access, requestId: 'req-real-un' });
    expect(reply.status).toBe(503);
    expect(json(reply)).toEqual({ error: 'unavailable' });
    expect(lines.filter((l) => l.includes('Capability not issued: unavailable'))).toHaveLength(1);
    expect(log()).not.toContain('sentinel-pw');
    expect(log()).not.toContain('10.4.4.4');
    expect(log()).not.toContain('telesphoros_session_issuer');
    expect(log()).not.toContain(access);
  });

  it('the server\'s own refusals never use the alarm phrase', async () => {
    const { port: p } = await start(real(new Store()));
    await post(p, '{"accessToken":');
    await post(p, validBody, { 'content-type': 'text/plain' });
    await post(p, JSON.stringify({ ...validBody, accessToken: 'a'.repeat(MAX_BODY_BYTES) }));
    expect(lines.length).toBeGreaterThanOrEqual(3); // they are logged, by code
    expect(log()).not.toContain('Capability not issued');
    expect(log()).not.toContain('opaque-access-token-sentinel');
  });
});
