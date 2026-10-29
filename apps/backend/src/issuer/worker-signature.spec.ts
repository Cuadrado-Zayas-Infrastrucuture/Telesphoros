import { randomBytes } from 'node:crypto';
import { MAX_CLOCK_SKEW_MS, signWorkerRequest, verifyWorkerRequest, WORKER_CALLER, workerKeyProblem } from './worker-signature';

/** Spec 012 slice 2 (plan D1): the evaluation worker signs each job-capability request with its own key, and the issuer checks the signature first. */
const key = randomBytes(32);
const now = Date.parse('2026-10-29T12:00:00.000Z');
const body = Buffer.from(JSON.stringify({ jobId: '00000000-0000-4000-8000-000000000001', workerId: 'syn-worker-1', requestId: 'req-1' }));
const request = { method: 'POST', path: '/v1/job-capabilities', body };
const signed = (overrides: Partial<Parameters<typeof signWorkerRequest>[0]> = {}) => signWorkerRequest({ key, ...request, timestamp: now, ...overrides });
const verify = (headers: Record<string, string | undefined>, overrides: Partial<Parameters<typeof verifyWorkerRequest>[0]> = {}) =>
  verifyWorkerRequest({ key, ...request, headers, now, ...overrides });

describe('signed worker requests', () => {
  it('accepts a request signed with the key, and names the caller and the nonce (control)', () => {
    const headers = signed();
    const result = verify(headers);
    expect(result).toEqual({ ok: true, caller: WORKER_CALLER, nonce: headers['x-telesphoros-nonce'] });
  });

  it('gives every request its own nonce', () => {
    expect(signed()['x-telesphoros-nonce']).not.toBe(signed()['x-telesphoros-nonce']);
  });

  it.each([
    ['no signature', (h: Record<string, string>) => ({ ...h, 'x-telesphoros-signature': undefined }), 'unsigned'],
    ['no caller', (h: Record<string, string>) => ({ ...h, 'x-telesphoros-caller': undefined }), 'unsigned'],
    ['another caller', (h: Record<string, string>) => ({ ...h, 'x-telesphoros-caller': 'api' }), 'unknown-caller'],
    ['a malformed timestamp', (h: Record<string, string>) => ({ ...h, 'x-telesphoros-timestamp': '12.5' }), 'malformed'],
    ['a malformed nonce', (h: Record<string, string>) => ({ ...h, 'x-telesphoros-nonce': 'short' }), 'malformed'],
    ['a malformed signature', (h: Record<string, string>) => ({ ...h, 'x-telesphoros-signature': 'not-base64url!' }), 'malformed'],
    ['another nonce than the one signed', (h: Record<string, string>) => ({ ...h, 'x-telesphoros-nonce': signed()['x-telesphoros-nonce'] }), 'bad-signature'],
  ])('refuses %s', (_case, change, reason) => {
    expect(verify(change(signed()))).toEqual({ ok: false, reason });
  });

  it('refuses a signature made with another key', () => {
    expect(verify(signWorkerRequest({ key: randomBytes(32), ...request, timestamp: now }))).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it.each([
    ['a changed body', { body: Buffer.from(body.toString().replace('syn-worker-1', 'syn-worker-2')) }],
    ['another path', { path: '/v1/capabilities' }],
    ['another method', { method: 'PUT' }],
  ])('refuses the signature over %s', (_case, overrides) => {
    expect(verify(signed(), overrides)).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('accepts a timestamp within the allowed skew either way and refuses one beyond it', () => {
    expect(verify(signed({ timestamp: now - MAX_CLOCK_SKEW_MS })).ok).toBe(true);
    expect(verify(signed({ timestamp: now + MAX_CLOCK_SKEW_MS })).ok).toBe(true);
    expect(verify(signed({ timestamp: now - MAX_CLOCK_SKEW_MS - 1 }))).toEqual({ ok: false, reason: 'stale' });
    expect(verify(signed({ timestamp: now + MAX_CLOCK_SKEW_MS + 1 }))).toEqual({ ok: false, reason: 'stale' });
  });

  it('checks the signature before the clock, so a stale request with a wrong key is still a bad signature', () => {
    const other = signWorkerRequest({ key: randomBytes(32), ...request, timestamp: now - 10 * MAX_CLOCK_SKEW_MS });
    expect(verify(other)).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('never returns the key, the signature or the body in a refusal', () => {
    const headers = signed();
    const refused = JSON.stringify(verify({ ...headers, 'x-telesphoros-timestamp': String(now - 10 * MAX_CLOCK_SKEW_MS) }));
    expect(refused).not.toContain(key.toString('base64url'));
    expect(refused).not.toContain(headers['x-telesphoros-signature']!);
    expect(refused).not.toContain('syn-worker-1');
  });

  it.each([
    ['missing', undefined, 'is required'],
    ['shorter than 32 bytes', randomBytes(31).toString('base64url'), 'at least 32 bytes'],
    ['not base64url', `${'a'.repeat(43)}=`, 'base64url'],
  ])('describes a key that is %s, without echoing it', (_case, value, rule) => {
    const problem = workerKeyProblem(value);
    expect(problem).toContain(rule);
    if (value) expect(problem).not.toContain(value);
  });

  it('accepts a 32-byte base64url key (control)', () => {
    expect(workerKeyProblem(randomBytes(32).toString('base64url'))).toBeUndefined();
  });
});
