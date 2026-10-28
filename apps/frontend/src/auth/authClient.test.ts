import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthConfig } from './authConfig';

// Replace the library with recorders, so we test OUR choices (where state lives, what is discarded), not the library.
const manager = {
  signinRedirect: vi.fn(async () => undefined),
  signinRedirectCallback: vi.fn(),
  removeUser: vi.fn(async () => undefined),
};
let settings: Record<string, unknown> = {};
vi.mock('oidc-client-ts', () => ({
  InMemoryWebStorage: class InMemoryWebStorage {},
  WebStorageStateStore: class WebStorageStateStore {
    constructor(readonly options: { store: unknown }) {}
  },
  UserManager: class UserManager {
    constructor(given: Record<string, unknown>) {
      settings = given;
      return manager as unknown as UserManager;
    }
  },
}));

import { createAuthClient } from './authClient';

const config: AuthConfig = {
  authority: 'https://idp.example.test/pool',
  clientId: 'client-1',
  signInDomain: 'https://login.example.test',
  apiBaseUrl: 'https://api.example.test',
  redirectUri: 'https://app.example.test/auth/callback',
  logoutUri: 'https://app.example.test/signed-out',
};
const user = (state: unknown) => ({ access_token: 'access-1', id_token: 'id-1', refresh_token: 'refresh-1', expires_at: 1_900_000_000, state });

beforeEach(() => {
  vi.clearAllMocks();
  settings = {};
});

describe('createAuthClient: configuration', () => {
  it('uses the code flow, keeps the USER (tokens) in memory and only the PKCE STATE in sessionStorage, and never renews silently', () => {
    createAuthClient(config);
    const userStore = settings.userStore as { options: { store: object } };
    const stateStore = settings.stateStore as { options: { store: unknown } };
    expect(userStore.options.store.constructor.name).toBe('InMemoryWebStorage');
    expect(stateStore.options.store).toBe(window.sessionStorage);
    expect(stateStore.options.store).not.toBe(window.localStorage);
    expect(settings).toMatchObject({
      authority: config.authority,
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      response_type: 'code',
      scope: 'openid email',
      automaticSilentRenew: false,
      monitorSession: false,
      loadUserInfo: false,
    });
  });
});

describe('createAuthClient: signing in', () => {
  it('remembers only a SAFE on-site return path through the redirect', async () => {
    const client = createAuthClient(config);
    await client.signIn('/reports/upload?x=1');
    expect(manager.signinRedirect).toHaveBeenLastCalledWith({ state: { returnTo: '/reports/upload?x=1' } });
    await client.signIn('https://evil.example.com');
    expect(manager.signinRedirect).toHaveBeenLastCalledWith({ state: { returnTo: '/' } });
  });

  it('keeps ONLY the access token: the ID and refresh tokens are dropped from memory right away', async () => {
    manager.signinRedirectCallback.mockResolvedValue(user({ returnTo: '/reports/upload' }));
    const session = await createAuthClient(config).completeSignIn();
    expect(session).toEqual({ accessToken: 'access-1', expiresAt: 1_900_000_000, returnTo: '/reports/upload' });
    expect(JSON.stringify(session)).not.toMatch(/id-1|refresh-1/);
    expect(manager.removeUser).toHaveBeenCalledTimes(1);
  });

  it('keeps the ID token’s email claim and nothing else from it; the ID token itself is still dropped', async () => {
    manager.signinRedirectCallback.mockResolvedValue({
      ...user({ returnTo: '/settings' }),
      profile: { sub: 'person-1', email: 'alice@example.test', email_verified: true, 'cognito:username': 'person-1', aud: 'client-1' },
    });
    const session = await createAuthClient(config).completeSignIn();
    expect(session).toEqual({ accessToken: 'access-1', expiresAt: 1_900_000_000, returnTo: '/settings', email: 'alice@example.test' });
    expect(JSON.stringify(session)).not.toMatch(/id-1|refresh-1|person-1|cognito/);
    expect(manager.removeUser).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['no email claim', { sub: 'person-1' }],
    ['an empty email', { sub: 'person-1', email: '' }],
    ['a non-string email', { sub: 'person-1', email: ['alice@example.test'] }],
  ])('holds no email when the ID token has %s', async (_name, profile) => {
    manager.signinRedirectCallback.mockResolvedValue({ ...user({ returnTo: '/' }), profile });
    const session = await createAuthClient(config).completeSignIn();
    expect(session).not.toHaveProperty('email');
  });

  it.each([
    ['an external URL', 'https://evil.example.com'],
    ['a missing state', undefined],
    ['the callback itself', '/auth/callback?code=1'],
  ])('ignores %s as the place to return to', async (_name, returnTo) => {
    manager.signinRedirectCallback.mockResolvedValue(user(returnTo === undefined ? undefined : { returnTo }));
    expect((await createAuthClient(config).completeSignIn()).returnTo).toBe('/');
  });

  it('redeems the one-time code only once, even if asked twice (React StrictMode runs effects twice)', async () => {
    manager.signinRedirectCallback.mockResolvedValue(user({ returnTo: '/' }));
    const client = createAuthClient(config);
    const [a, b] = await Promise.all([client.completeSignIn(), client.completeSignIn()]);
    expect(manager.signinRedirectCallback).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
  });

  it('propagates a failed redemption (expired or replayed code)', async () => {
    manager.signinRedirectCallback.mockRejectedValue(new Error('invalid_grant'));
    await expect(createAuthClient(config).completeSignIn()).rejects.toThrow('invalid_grant');
  });
});

describe('createAuthClient: signing out', () => {
  it('forgets the user, then ends the provider session at its sign-out address with the registered return address', async () => {
    const navigate = vi.fn();
    await createAuthClient(config, { navigate }).signOut();
    expect(manager.removeUser).toHaveBeenCalledTimes(1);
    const target = new URL(navigate.mock.calls[0]![0] as string);
    expect(target.origin + target.pathname).toBe('https://login.example.test/logout');
    expect(target.searchParams.get('client_id')).toBe('client-1');
    expect(target.searchParams.get('logout_uri')).toBe('https://app.example.test/signed-out');
  });
});
