import { createHash } from 'node:crypto';
import { type FakeIdp, startFakeIdp } from '@telesphoros/fake-idp';
import { invalidTokenCases, noTenantCases } from '../../test/helpers/token-rejections';
import { CognitoTokenVerifier } from '../auth/cognito-token-verifier';
import { CapabilityIssueError, type CapabilityIssueRequest, type CapabilityIssuerPort, NullCapabilityIssuer } from './capability-issuer.port';
import { type CapabilityIssueStore, type IssueCall, IssuerCore } from './issuer-core';

/**
 * DATA-01 T013: the issuer verifies the access token with `CognitoTokenVerifier`, unchanged, before it asks the database for anything. Every token the
 * API refuses (the shared table in test/helpers/token-rejections.ts) the issuer refuses too, and no refusal reaches the store. Each refusal is followed
 * by a positive control on the same issuer: a valid token still issues, so "the store was not called" means the token was refused, not that the store is dead.
 */
let idp: FakeIdp;
beforeAll(async () => {
  idp = await startFakeIdp({ clientId: 'app-client' });
});
afterAll(() => idp.stop());

class RecordingStore implements CapabilityIssueStore {
  readonly calls: IssueCall[] = [];
  outcome: { expiresAt: Date | null; refusal: string | null; membershipVersion: number | null } | Error = { expiresAt: new Date('2030-01-01T00:00:00Z'), refusal: null, membershipVersion: 7 };
  async issue(call: IssueCall) {
    this.calls.push(call);
    if (this.outcome instanceof Error) throw this.outcome;
    return this.outcome;
  }
}

const verifier = () => new CognitoTokenVerifier({ issuer: idp.issuer, clientId: 'app-client', cooldownMs: 0 });
const alice = () => idp.users.find((u) => u.email.startsWith('alice'))!;
const request = async (over: Partial<CapabilityIssueRequest> = {}): Promise<CapabilityIssueRequest> => ({
  accessToken: await idp.mintAccessToken({ user: alice() }),
  requestId: 'req-issuer-0001',
  ...over,
});
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest();
const reasonOf = async (promise: Promise<unknown>) => {
  const error = await promise.then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(CapabilityIssueError);
  return error as CapabilityIssueError;
};

describe('IssuerCore: the positive control', () => {
  it('verifies the token, mints 32 random bytes, and hands the store only their sha256, with the verified tenant and person', async () => {
    const store = new RecordingStore();
    const issued = await new IssuerCore(verifier(), store).issue(await request());
    expect(issued!.token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes, base64url, no padding
    expect(issued!.expiresAt).toEqual(new Date('2030-01-01T00:00:00Z'));
    expect(issued!.membershipVersion).toBe(7); // the version the DATABASE read, handed back; the caller never supplied one
    expect(store.calls).toHaveLength(1);
    const call = store.calls[0]!;
    expect(call).toMatchObject({ tenant: 'alpha', sub: alice().sub, purpose: 'request', requestId: 'req-issuer-0001' });
    expect(call).not.toHaveProperty('membershipVersion'); // nothing the caller can assert about the membership reaches the database
    expect(call.tokenHash).toEqual(sha256(issued!.token)); // the database hashes the text it is later given
    expect(JSON.stringify(call)).not.toContain(issued!.token); // the raw token never goes to the store
  });

  it('mints a fresh token every time', async () => {
    const core = new IssuerCore(verifier(), new RecordingStore());
    const tokens = new Set<string>();
    for (let i = 0; i < 20; i += 1) tokens.add((await core.issue(await request()))!.token);
    expect(tokens.size).toBe(20);
  });
});

describe('IssuerCore: refuses every token the API refuses (T013)', () => {
  it.each(invalidTokenCases(() => idp, 'app-client'))('%s', async (_name, make) => {
    const store = new RecordingStore();
    const core = new IssuerCore(verifier(), store);
    const error = await reasonOf(core.issue(await request({ accessToken: await make() })));
    expect(error.reason).toBe('invalid-token');
    expect(error.message).toBe('Invalid token'); // one generic message: callers learn nothing
    expect(store.calls).toHaveLength(0);
    await expect(core.issue(await request())).resolves.toBeDefined(); // control: the same issuer still issues for a valid token
    expect(store.calls).toHaveLength(1);
  });

  it.each(noTenantCases(() => idp))('a genuine token without exactly one tenant: %s', async (_name, make) => {
    const store = new RecordingStore();
    const core = new IssuerCore(verifier(), store);
    expect((await reasonOf(core.issue(await request({ accessToken: await make() })))).reason).toBe('no-tenant');
    expect(store.calls).toHaveLength(0);
    await expect(core.issue(await request())).resolves.toBeDefined();
  });
});

describe('IssuerCore: the rest of the request', () => {
  it.each([null, 0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])('an issued answer with a membership version of %s is a failure, not a capability', async (membershipVersion) => {
    const store = new RecordingStore();
    store.outcome = { expiresAt: new Date('2030-01-01T00:00:00Z'), refusal: null, membershipVersion };
    expect((await reasonOf(new IssuerCore(verifier(), store).issue(await request()))).reason).toBe('unavailable');
    store.outcome = { expiresAt: new Date('2030-01-01T00:00:00Z'), refusal: null, membershipVersion: 7 };
    await expect(new IssuerCore(verifier(), store).issue(await request())).resolves.toBeDefined(); // control: a valid version issues
  });

  it('passes the database refusal on as a closed code, and returns no token', async () => {
    const store = new RecordingStore();
    store.outcome = { expiresAt: null, refusal: 'membership-not-current', membershipVersion: null };
    const error = await reasonOf(new IssuerCore(verifier(), store).issue(await request()));
    expect(error).toMatchObject({ reason: 'refused', detail: 'membership-not-current' });
    expect(store.calls).toHaveLength(1);
    expect(JSON.stringify(error)).not.toContain(store.calls[0]!.tokenHash.toString('hex'));
  });

  it('answers "unavailable" when the database fails, without repeating its message', async () => {
    const store = new RecordingStore();
    store.outcome = new Error('connection to server at 10.0.0.9 refused, password authentication failed for telesphoros_session_issuer');
    const error = await reasonOf(new IssuerCore(verifier(), store).issue(await request()));
    expect(error.reason).toBe('unavailable');
    expect(error.message).not.toContain('10.0.0.9');
  });

  it('a store that answers neither an expiry nor a refusal is a failure, not a token', async () => {
    const store = new RecordingStore();
    store.outcome = { expiresAt: null, refusal: null, membershipVersion: null };
    expect((await reasonOf(new IssuerCore(verifier(), store).issue(await request()))).reason).toBe('unavailable');
  });
});

describe('NullCapabilityIssuer: the default when no issuer is configured', () => {
  it('mints nothing and says so', async () => {
    const port: CapabilityIssuerPort = new NullCapabilityIssuer();
    await expect(port.issue(await request())).resolves.toBeUndefined();
  });
});
