import { randomBytes } from 'node:crypto';
import { CapabilityIssueError } from './capability-issuer.port';
import { HttpJobCapabilityClient, JOB_CAPABILITIES_PATH } from './job-capability-client';
import { verifyWorkerRequest } from './worker-signature';

/**
 * Spec 012 slice 3: the worker's client for the job route. Its wire is pinned by the route's own spec (test/db/issuer-job-route.pg-spec.ts) and here by a
 * fake `fetch` that checks the signature the way the issuer does. The real round trip is test/evaluation-request-worker-capability.e2e-spec.ts.
 */
const key = randomBytes(32);
const token = 'T'.repeat(43);
const job = { jobId: '9b2f6c1e-3d4a-4b5c-8d6e-7f8091a2b3c4', workerId: 'evaluation-1' };
const issued = { token, expiresAt: '2026-10-29T12:00:00.000Z', membershipVersion: 3, tenantId: '11111111-1111-1111-1111-111111111111', sub: 'syn-clinician' };

interface Seen {
  url: string;
  headers: Record<string, string>;
  body: Buffer;
}

function client(answers: (() => Response | Promise<Response>)[], seen: Seen[] = []) {
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push({ url, headers: init.headers as Record<string, string>, body: init.body as Buffer });
    const next = answers.shift();
    if (!next) throw new Error('no more answers');
    return next();
  }) as unknown as typeof fetch;
  return new HttpJobCapabilityClient({ baseUrl: 'http://session-issuer:8082', key, fetchImpl, retryPauseMs: 1 });
}
const json = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const failure = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(CapabilityIssueError);
  const { reason, detail, message } = error as CapabilityIssueError;
  expect(message).not.toMatch(/session-issuer|8082/);
  expect(message).not.toContain(key.toString('base64url'));
  return { reason, detail };
};

describe('HttpJobCapabilityClient', () => {
  it('sends a request the issuer accepts as signed, and returns the capability with the organization and person (control)', async () => {
    const seen: Seen[] = [];
    const answer = await client([json(200, issued)], seen).issue(job);
    expect(answer).toEqual({ ...issued, expiresAt: new Date(issued.expiresAt) });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(`http://session-issuer:8082${JOB_CAPABILITIES_PATH}`);
    expect(JSON.parse(seen[0]!.body.toString())).toEqual({ ...job, requestId: job.jobId });
    const verdict = verifyWorkerRequest({ key, method: 'POST', path: JOB_CAPABILITIES_PATH, body: seen[0]!.body, headers: seen[0]!.headers, now: Date.now() });
    expect(verdict.ok).toBe(true);
    expect(verifyWorkerRequest({ key: randomBytes(32), method: 'POST', path: JOB_CAPABILITIES_PATH, body: seen[0]!.body, headers: seen[0]!.headers, now: Date.now() })).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
  });

  it.each([
    ['a refusal with its code', json(403, { error: 'refused', detail: 'job-not-held' }), { reason: 'refused', detail: 'job-not-held' }],
    ['a refusal with a code that is not one', json(403, { error: 'refused', detail: 'Not A Code!' }), { reason: 'refused', detail: undefined }],
    ['an unauthenticated request', json(401, { error: 'unauthenticated' }), { reason: 'unauthenticated', detail: undefined }],
    ['a replay', json(401, { error: 'replayed' }), { reason: 'replayed', detail: undefined }],
    ['an invalid request', json(400, { error: 'invalid-request' }), { reason: 'invalid-request', detail: undefined }],
    ['an issuer without the job route', json(404, { error: 'not-found' }), { reason: 'unavailable', detail: 'not-served' }],
    ['a status the route never answers', json(418, { error: 'refused' }), { reason: 'unavailable', detail: 'bad-status' }],
    ['an error the status does not carry', json(401, { error: 'refused' }), { reason: 'unavailable', detail: 'bad-response' }],
    ['a 200 without the person', json(200, { ...issued, sub: undefined }), { reason: 'unavailable', detail: 'bad-response' }],
    ['a 200 with a token that is not one', json(200, { ...issued, token: 'short' }), { reason: 'unavailable', detail: 'bad-response' }],
  ])('maps %s, once, without retrying', async (_case, answer, expected) => {
    const seen: Seen[] = [];
    expect(await failure(client([answer, json(200, issued)], seen).issue(job))).toEqual(expected);
    expect(seen).toHaveLength(1);
  });

  it('retries a 503 once with a NEW signed request, because the issuer accepts each nonce once', async () => {
    const seen: Seen[] = [];
    expect(await client([json(503, { error: 'unavailable' }), json(200, issued)], seen).issue(job)).toMatchObject({ token });
    expect(seen).toHaveLength(2);
    expect(seen[0]!.headers['x-telesphoros-nonce']).not.toBe(seen[1]!.headers['x-telesphoros-nonce']);
  });

  it('retries a failed connection once, then gives up as unavailable', async () => {
    const down = () => {
      throw new TypeError('connect ECONNREFUSED 10.0.0.1:8082');
    };
    const seen: Seen[] = [];
    expect(await failure(client([down, down, json(200, issued)], seen).issue(job))).toEqual({ reason: 'unavailable', detail: 'network' });
    expect(seen).toHaveLength(2);
  });

  it('refuses an address it would not call, naming the rule and not the value', () => {
    expect(() => new HttpJobCapabilityClient({ baseUrl: 'http://user:secret@session-issuer:8082', key })).toThrow(/must not carry credentials/);
    expect(() => new HttpJobCapabilityClient({ baseUrl: 'http://user:secret@session-issuer:8082', key })).not.toThrow(/secret/);
  });
});
