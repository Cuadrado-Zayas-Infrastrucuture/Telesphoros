import { randomBytes } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Logger } from '@nestjs/common';
import { issuerUrlProblem } from '../config/env';
import { CAPABILITY_TOKEN_PATTERN, CapabilityIssueError, type CapabilityIssueFailure, type CapabilityIssueRequest, type IssuedCapability } from './capability-issuer.port';
import { checkIssuerBaseUrl, HttpCapabilityIssuer, ISSUER_CLIENT_TIMEOUT_MS, MAX_ISSUER_RESPONSE_BYTES, type HttpCapabilityIssuerOptions } from './issuer-http-client';
import { CAPABILITY_ISSUE_TIMEOUT_MS } from './request-capabilities';

/**
 * DATA-01 PR B: the API's client for the session issuer, against a fake issuer on a local node:http server. The fake speaks the wire the real server speaks
 * (issuer-server.ts); the pg-spec (test/db/issuer-client.pg-spec.ts) calls the REAL server through this client. Every refusal test is followed by the success
 * control on the same fake, because a refusal means something only against a server that issues.
 *
 * Values that look like credentials are built at run time from a marker. A literal `NAME: 'value'` pair is a gitleaks finding in the commit that has it.
 */
const marker = () => `sentinel-${randomBytes(9).toString('hex')}`;
const newToken = () => randomBytes(32).toString('base64url');
const ACCESS = marker();
const REQUEST: CapabilityIssueRequest = { accessToken: ACCESS, requestId: 'req-client-0001' };
const VERSION = 7;

interface Call {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingHttpHeaders;
  body: string;
}
type Handler = (req: IncomingMessage, res: ServerResponse, call: Call) => void;

class Fake {
  readonly calls: Call[] = [];
  private server: Server;
  constructor(private handler: Handler) {
    this.server = createServer((req, res) => {
      const parts: Buffer[] = [];
      req.on('data', (chunk: Buffer) => parts.push(chunk));
      req.on('end', () => {
        const call: Call = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(parts).toString('utf8') };
        this.calls.push(call);
        this.handler(req, res, call);
      });
    });
  }
  async start(): Promise<this> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    return this;
  }
  get url(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  set(handler: Handler): void {
    this.handler = handler;
  }
  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

const json = (res: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', connection: 'close', ...headers });
  res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
};
const issued =
  (token = newToken(), expiresAt = new Date(Date.now() + 60_000).toISOString(), membershipVersion = VERSION): Handler =>
  (_req, res) =>
    json(res, 200, { token, expiresAt, membershipVersion });

const fakes: Fake[] = [];
const fake = async (handler: Handler): Promise<Fake> => {
  const f = await new Fake(handler).start();
  fakes.push(f);
  return f;
};
const clientFor = (f: Fake | string, over: Partial<HttpCapabilityIssuerOptions> = {}) =>
  new HttpCapabilityIssuer({ baseUrl: typeof f === 'string' ? f : f.url, retryPauseMs: 5, ...over });
const countingFetch = () => {
  const state = { n: 0 };
  const fetchImpl: typeof fetch = (...args) => {
    state.n += 1;
    return fetch(...args);
  };
  return { state, fetchImpl };
};
async function outcome(client: HttpCapabilityIssuer, request: CapabilityIssueRequest = REQUEST): Promise<{ issued?: IssuedCapability | undefined; error?: unknown }> {
  try {
    return { issued: await client.issue(request) };
  } catch (error) {
    return { error };
  }
}
async function failure(client: HttpCapabilityIssuer, request: CapabilityIssueRequest = REQUEST): Promise<CapabilityIssueError> {
  const result = await outcome(client, request);
  expect(result.error).toBeInstanceOf(CapabilityIssueError);
  return result.error as CapabilityIssueError;
}

const logged: string[] = [];
beforeEach(() => {
  logged.length = 0;
  const sink = (message: unknown) => void logged.push(typeof message === 'string' ? message : JSON.stringify(message));
  Logger.overrideLogger({ log: sink, error: sink, warn: sink, debug: sink, verbose: sink, fatal: sink });
});
afterEach(async () => {
  Logger.overrideLogger(['log', 'error', 'warn']);
  await Promise.all(fakes.splice(0).map((f) => f.stop()));
});

describe('the positive control: a normal issuance', () => {
  it('posts the exact wire the server expects and returns the capability', async () => {
    const token = newToken();
    const expiresAt = new Date(Date.now() + 60_000);
    const f = await fake(issued(token, expiresAt.toISOString()));
    const result = await clientFor(f).issue(REQUEST);
    expect(result).toEqual({ token, expiresAt, membershipVersion: VERSION });
    expect(result!.token).toMatch(CAPABILITY_TOKEN_PATTERN);
    expect(f.calls).toHaveLength(1);
    const call = f.calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe('/v1/capabilities');
    expect(call.headers['content-type']).toMatch(/^application\/json/);
    expect(Object.keys(JSON.parse(call.body)).sort()).toEqual(['accessToken', 'requestId']); // the version is the database's to read: the request names none
    expect(JSON.parse(call.body)).toEqual(REQUEST);
    expect(logged).toEqual([]); // a success writes nothing
  });

  it('accepts a base URL with or without the trailing slash', async () => {
    const f = await fake(issued());
    expect(await clientFor(`${f.url}/`).issue(REQUEST)).toBeDefined();
    expect(f.calls[0]!.url).toBe('/v1/capabilities');
  });
});

describe('the status table, exactly as issuer-server.ts writes it', () => {
  const table: [number, Record<string, string>, CapabilityIssueFailure, string | undefined][] = [
    [401, { error: 'invalid-token' }, 'invalid-token', undefined],
    [403, { error: 'no-tenant' }, 'no-tenant', undefined],
    [400, { error: 'invalid-request' }, 'invalid-request', undefined],
    [403, { error: 'refused', detail: 'membership-not-current' }, 'refused', 'membership-not-current'],
    [403, { error: 'refused' }, 'refused', undefined],
    [503, { error: 'unavailable' }, 'unavailable', 'server'],
  ];
  for (const [status, body, reason, detail] of table) {
    it(`${status} ${JSON.stringify(body)} is ${reason}${detail ? ` (${detail})` : ''}`, async () => {
      const f = await fake((_req, res) => json(res, status, body));
      const error = await failure(clientFor(f));
      expect([error.reason, error.detail]).toEqual([reason, detail]);
      f.set(issued());
      expect(await clientFor(f).issue(REQUEST)).toBeDefined(); // control: the same fake issues once it is told to
    });
  }

  it('the two 403s are told apart by the error field, not by the status', async () => {
    const f = await fake((_req, res) => json(res, 403, { error: 'no-tenant' }));
    const noTenant = await failure(clientFor(f));
    f.set((_req, res) => json(res, 403, { error: 'refused', detail: 'rate-limited' }));
    const refused = await failure(clientFor(f));
    expect([noTenant.reason, refused.reason]).toEqual(['no-tenant', 'refused']);
    expect(refused.detail).toBe('rate-limited');
  });

  it('every reason the port knows is reachable from the table (a new reason in the port needs a decision here)', () => {
    const covered = new Set(table.map(([, , reason]) => reason));
    const all: CapabilityIssueFailure[] = ['invalid-token', 'no-tenant', 'invalid-request', 'refused', 'unavailable'];
    expect(all.filter((r) => !covered.has(r))).toEqual([]);
  });

  it('a refusal detail is passed on only when it is a closed code', async () => {
    for (const detail of ['Membership-Not-Current', 'has space', 'x'.repeat(65), '', 'ünï', 'a_b', 'line\nbreak', '<script>']) {
      const f = await fake((_req, res) => json(res, 403, { error: 'refused', detail }));
      const error = await failure(clientFor(f));
      expect([detail, error.reason, error.detail]).toEqual([detail, 'refused', undefined]);
    }
    const f = await fake((_req, res) => json(res, 403, { error: 'refused', detail: 'a'.repeat(64) }));
    expect((await failure(clientFor(f))).detail).toBe('a'.repeat(64));
  });

  it('a status and an error field that do not belong together are unavailable, not whichever the body says', async () => {
    const mismatched: [number, unknown][] = [
      [401, { error: 'no-tenant' }],
      [401, { error: 'refused' }],
      [403, { error: 'invalid-token' }],
      [400, { error: 'refused' }],
      [503, { error: 'invalid-token' }],
      [200, { error: 'unavailable' }],
      [403, { error: 'something-new' }],
      [403, {}],
      [403, { detail: 'x' }],
    ];
    for (const [status, body] of mismatched) {
      const f = await fake((_req, res) => json(res, status, body));
      const error = await failure(clientFor(f));
      expect([status, JSON.stringify(body), error.reason]).toEqual([status, JSON.stringify(body), 'unavailable']);
    }
  });

  it('413, 415, 404, 500 and 302 are the issuer or the client being wrong: unavailable, and not retried', async () => {
    for (const status of [413, 415, 404, 500, 302, 204]) {
      const counted = countingFetch();
      const f = await fake((_req, res) => json(res, status, { error: 'payload-too-large' }));
      const error = await failure(clientFor(f, { fetchImpl: counted.fetchImpl }));
      expect([status, error.reason, counted.state.n]).toEqual([status, 'unavailable', 1]);
    }
  });
});

describe('the one retry', () => {
  it('a 503 followed by an answer is retried once and the answer is used', async () => {
    let n = 0;
    const token = newToken();
    const f = await fake((req, res, call) => (++n === 1 ? json(res, 503, { error: 'unavailable' }) : issued(token)(req, res, call)));
    expect((await clientFor(f).issue(REQUEST))!.token).toBe(token);
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1]!.body).toBe(f.calls[0]!.body); // the same request id: the retry is the same request
  });

  it('two 503s are two calls, not three, and the result is unavailable', async () => {
    const f = await fake((_req, res) => json(res, 503, { error: 'unavailable' }));
    const error = await failure(clientFor(f));
    expect([error.reason, f.calls.length]).toEqual(['unavailable', 2]);
  });

  it('a connection that the issuer cuts is retried once; a second cut is unavailable (network)', async () => {
    let n = 0;
    const token = newToken();
    const f = await fake((req, res, call) => (++n === 1 ? req.socket.destroy() : issued(token)(req, res, call)));
    expect((await clientFor(f).issue(REQUEST))!.token).toBe(token);
    expect(f.calls).toHaveLength(2);
    const cut = await fake((req) => req.socket.destroy());
    const error = await failure(clientFor(cut));
    expect([error.reason, error.detail, cut.calls.length]).toEqual(['unavailable', 'network', 2]);
  });

  it('nothing listening is retried once and is unavailable (network)', async () => {
    const closed = await fake(issued());
    const url = closed.url;
    await closed.stop();
    fakes.splice(fakes.indexOf(closed), 1);
    const counted = countingFetch();
    const error = await failure(clientFor(url, { fetchImpl: counted.fetchImpl }));
    expect([error.reason, error.detail, counted.state.n]).toEqual(['unavailable', 'network', 2]);
  });

  it('a refusal is never retried: 400, 401 and both 403s are one call each, and the retry cannot turn a refusal into an issuance', async () => {
    const answers: [number, unknown][] = [
      [400, { error: 'invalid-request' }],
      [401, { error: 'invalid-token' }],
      [403, { error: 'no-tenant' }],
      [403, { error: 'refused', detail: 'rate-limited' }],
    ];
    for (const [status, body] of answers) {
      const counted = countingFetch();
      const f = await fake((_req, res) => json(res, status, body));
      await failure(clientFor(f, { fetchImpl: counted.fetchImpl }));
      expect([status, counted.state.n, f.calls.length]).toEqual([status, 1, 1]);
    }
  });

  it('a malformed answer to a 200 is not retried (the issuer already issued; asking again would mint a second capability)', async () => {
    const f = await fake((_req, res) => json(res, 200, '{not json'));
    const error = await failure(clientFor(f));
    expect([error.reason, error.detail, f.calls.length]).toEqual(['unavailable', 'bad-response', 1]);
  });

  it('no retry when too little of the deadline is left', async () => {
    const f = await fake((_req, res) => json(res, 503, { error: 'unavailable' }));
    const error = await failure(clientFor(f, { timeoutMs: 400 }));
    expect([error.reason, f.calls.length]).toEqual(['unavailable', 1]);
    const roomy = await fake((_req, res) => json(res, 503, { error: 'unavailable' }));
    await failure(clientFor(roomy, { timeoutMs: 3000 }));
    expect(roomy.calls).toHaveLength(2);
  });
});

describe('the deadline', () => {
  it('an issuer that never answers is unavailable (timeout) at the deadline, and is not retried', async () => {
    const f = await fake(() => undefined);
    const started = Date.now();
    const error = await failure(clientFor(f, { timeoutMs: 200 }));
    expect([error.reason, error.detail, f.calls.length]).toEqual(['unavailable', 'timeout', 1]);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('an issuer that sends the headers and then stalls the body is cut at the deadline too', async () => {
    const f = await fake((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      res.write('{"token":');
    });
    const started = Date.now();
    const error = await failure(clientFor(f, { timeoutMs: 200 }));
    expect([error.reason, error.detail]).toEqual(['unavailable', 'timeout']);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("the default budget sits under the guard's wait and the server's own 10 s request timeout (D4's real p95 budget is still to be measured)", () => {
    expect(ISSUER_CLIENT_TIMEOUT_MS).toBe(2500);
    expect(ISSUER_CLIENT_TIMEOUT_MS).toBeLessThan(CAPABILITY_ISSUE_TIMEOUT_MS);
    expect(ISSUER_CLIENT_TIMEOUT_MS).toBeLessThan(10_000);
  });
});

describe('what comes back is checked before it is used', () => {
  const bad: [string, (res: ServerResponse) => void][] = [
    ['not JSON', (res) => json(res, 200, '<html>proxy error</html>')],
    ['an empty body', (res) => json(res, 200, '')],
    ['a JSON array', (res) => json(res, 200, '[]')],
    ['an extra key', (res) => json(res, 200, { token: newToken(), expiresAt: new Date().toISOString(), membershipVersion: VERSION, extra: 1 })],
    ['a missing expiresAt', (res) => json(res, 200, { token: newToken(), membershipVersion: VERSION })],
    ['a token of the wrong length', (res) => json(res, 200, { token: 'A'.repeat(42), expiresAt: new Date().toISOString(), membershipVersion: VERSION })],
    ['a token with a character outside base64url', (res) => json(res, 200, { token: `${'A'.repeat(42)}+`, expiresAt: new Date().toISOString(), membershipVersion: VERSION })],
    ['a token that is not a string', (res) => json(res, 200, { token: 12345, expiresAt: new Date().toISOString(), membershipVersion: VERSION })],
    ['an expiresAt that is not a date', (res) => json(res, 200, { token: newToken(), expiresAt: 'tomorrow', membershipVersion: VERSION })],
    ['an expiresAt that is a number', (res) => json(res, 200, { token: newToken(), expiresAt: Date.now(), membershipVersion: VERSION })],
    ['an answer with no membershipVersion (an issuer from before migration 0031)', (res) => json(res, 200, { token: newToken(), expiresAt: new Date().toISOString() })],
    ['a membershipVersion of 0', (res) => json(res, 200, { token: newToken(), expiresAt: new Date().toISOString(), membershipVersion: 0 })],
    ['a negative membershipVersion', (res) => json(res, 200, { token: newToken(), expiresAt: new Date().toISOString(), membershipVersion: -3 })],
    ['a fractional membershipVersion', (res) => json(res, 200, { token: newToken(), expiresAt: new Date().toISOString(), membershipVersion: 1.5 })],
    ['a membershipVersion that is a string', (res) => json(res, 200, { token: newToken(), expiresAt: new Date().toISOString(), membershipVersion: '7' })],
    ['an error body with an extra key', (res) => json(res, 401, { error: 'invalid-token', extra: 'x' })],
    ['a 503 with an unreadable body', (res) => json(res, 503, 'upstream connect error')],
  ];
  for (const [name, answer] of bad) {
    it(`${name} is unavailable (bad-response or bad-status), never a thrown raw error`, async () => {
      const f = await fake((_req, res) => answer(res));
      const result = await outcome(clientFor(f));
      expect(result.error).toBeInstanceOf(CapabilityIssueError);
      expect((result.error as CapabilityIssueError).reason).toBe('unavailable');
      f.set(issued());
      expect(await clientFor(f).issue(REQUEST)).toBeDefined(); // control
    });
  }

  it('a body over the cap is refused by its declared length, without reading it', async () => {
    const size = MAX_ISSUER_RESPONSE_BYTES + 1;
    const f = await fake((_req, res) => json(res, 200, 'x'.repeat(size), { 'content-length': String(size) }));
    const error = await failure(clientFor(f));
    expect([error.reason, error.detail]).toEqual(['unavailable', 'response-too-large']);
  });

  it('a body over the cap with no declared length is cut once it passes the cap', async () => {
    let sent = 0;
    const f = await fake((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' }); // chunked: no content-length
      const chunk = 'x'.repeat(1024);
      const timer = setInterval(() => {
        if (res.destroyed || sent > 64 * 1024) return clearInterval(timer);
        sent += chunk.length;
        res.write(chunk);
      }, 2);
      res.on('close', () => clearInterval(timer));
    });
    const error = await failure(clientFor(f, { timeoutMs: 3000 }));
    expect([error.reason, error.detail]).toEqual(['unavailable', 'response-too-large']);
    expect(sent).toBeLessThan(40 * 1024); // it stopped reading near the cap, it did not drain a runaway stream
  });

  it('a normal answer is far under the cap', () => {
    const body = JSON.stringify({ token: newToken(), expiresAt: new Date().toISOString(), membershipVersion: VERSION });
    expect(Buffer.byteLength(body)).toBeLessThan(MAX_ISSUER_RESPONSE_BYTES / 10);
  });

  it('a redirect is not followed: the token is not sent anywhere else', async () => {
    const elsewhere = await fake(issued());
    const f = await fake((_req, res) => json(res, 307, '', { location: `${elsewhere.url}/v1/capabilities` }));
    const error = await failure(clientFor(f));
    expect(error.reason).toBe('unavailable');
    expect(elsewhere.calls).toHaveLength(0);
  });

  it('whatever fetch throws is unavailable, even an error that carries a secret in its message', async () => {
    const secret = marker();
    const fetchImpl: typeof fetch = () => Promise.reject(Object.assign(new TypeError(`connect failed to ${secret}`), { cause: new Error(secret) }));
    const error = await failure(clientFor('http://127.0.0.1:9', { fetchImpl }));
    expect([error.reason, error.detail]).toEqual(['unavailable', 'network']);
    expect(JSON.stringify([error.message, error.detail, error.stack?.split('\n')[0]])).not.toContain(secret);
    expect(logged.join('\n')).not.toContain(secret);
  });
});

describe('nothing sensitive is logged or put in an error', () => {
  it('across every failure path: no token, no response body, no address, no URL, and not the alarm phrase', async () => {
    const respondedWith = marker();
    const capability = newToken();
    const paths: Handler[] = [
      (_req, res) => json(res, 503, { error: 'unavailable', note: respondedWith }),
      (_req, res) => json(res, 403, { error: 'refused', detail: 'membership-not-current', note: respondedWith }),
      (_req, res) => json(res, 200, { token: capability, expiresAt: respondedWith, membershipVersion: VERSION }),
      (_req, res) => json(res, 200, `${respondedWith}`),
      (_req, res) => json(res, 500, respondedWith),
      (req) => req.socket.destroy(),
      (_req, res) => json(res, 200, 'y'.repeat(MAX_ISSUER_RESPONSE_BYTES * 2)),
    ];
    const errors: CapabilityIssueError[] = [];
    let url = '';
    for (const handler of paths) {
      const f = await fake(handler);
      url = f.url;
      errors.push(await failure(clientFor(f)));
    }
    const hung = await fake(() => undefined);
    errors.push(await failure(clientFor(hung, { timeoutMs: 100 })));
    const everything = [...logged, ...errors.map((e) => `${e.detail ?? ''} ${e.stack ?? ''}`)].join('\n');
    expect(logged.length).toBeGreaterThan(0); // control: the retry paths DO log, so the checks below are looking at something
    for (const forbidden of [ACCESS, respondedWith, capability, url, new URL(url).host, new URL(url).port, '127.0.0.1', 'ECONNRESET', 'ECONNREFUSED', 'fetch failed']) {
      expect([forbidden, everything.includes(forbidden)]).toEqual([forbidden, false]);
    }
    // The alarm phrase is the issuer's to write (issuer.tf's metric filters count it there). The API's logs never carry it, so it is not counted twice.
    // (The port's own error message does contain it; nothing here logs a message, and RequestCapabilities logs only the reason code.)
    expect(logged.join('\n')).not.toContain('Capability not issued:');
    // The client's own lines are one short closed code.
    for (const line of logged) expect(line).toMatch(/^Issuer call retried: [a-z0-9-]{1,32}$/);
  });
});

describe('the base URL', () => {
  const accepted = ['http://session-issuer:8082', 'http://session-issuer:8082/', 'https://issuer.internal', 'http://127.0.0.1:1234', 'http://[::1]:8082'];
  const refused = [
    '',
    ' ',
    'session-issuer:8082',
    'not a url',
    'ftp://issuer',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'http://',
    'http://user@issuer',
    'http://user:pw@issuer',
    'http://:pw@issuer',
    'http://issuer/?a=1',
    'http://issuer?',
    'http://issuer/#frag',
    'http://issuer#',
    'http://issuer/prefix',
    'http://issuer//',
    ' http://issuer',
    'http://issuer ',
    'http://issuer\n',
  ];
  it('the client and the environment loader accept and refuse exactly the same values', () => {
    for (const value of accepted) expect([value, checkIssuerBaseUrl(value), issuerUrlProblem(value)]).toEqual([value, undefined, undefined]);
    for (const value of refused) {
      expect([value, typeof checkIssuerBaseUrl(value)]).toEqual([value, 'string']);
      expect([value, typeof issuerUrlProblem(value)]).toEqual([value, 'string']);
    }
  });

  it('the constructor refuses a bad URL and its message does not repeat the value', () => {
    const secret = marker();
    const host = marker();
    for (const value of [`http://user:${secret}@${host}`, `http://${host}/?token=${secret}`, `ftp://${secret}`, `http://${host}/#${secret}`, `http://${host}/${secret}`]) {
      let message = '';
      try {
        new HttpCapabilityIssuer({ baseUrl: value });
      } catch (error) {
        message = (error as Error).message;
      }
      expect([value, message.length > 0]).toEqual([value, true]);
      expect(message).not.toContain(secret);
      expect(message).not.toContain(host);
    }
  });

  it('a non-positive or absurd deadline is refused when the client is built, not when the first request is slow', () => {
    for (const timeoutMs of [0, -1, Number.NaN, 10_000, 60_000]) expect(() => new HttpCapabilityIssuer({ baseUrl: 'http://issuer:1', timeoutMs })).toThrow(/timeout/i);
  });
});
