import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { API, fakeClient, fakeFetch, TOKEN } from '@/test/authTestUtils';
import { AuthProvider, NotSignedInError, SessionEndedError, useAuth } from './AuthProvider';

function setup(options: { client?: ReturnType<typeof fakeClient>; fetchImpl?: ReturnType<typeof fakeFetch> } = {}) {
  const client = options.client ?? fakeClient({ returnTo: '/reports/upload' });
  const fetchImpl = options.fetchImpl ?? fakeFetch({ roles: ['clinician'] });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <AuthProvider client={client} apiBaseUrl={API} fetchImpl={fetchImpl as unknown as typeof fetch}>
      {children}
    </AuthProvider>
  );
  return { ...renderHook(() => useAuth(), { wrapper }), client, fetchImpl };
}
afterEach(() => vi.restoreAllMocks());

describe('AuthProvider', () => {
  it('starts signed out with no roles, and refuses API calls', async () => {
    const { result } = setup();
    expect(result.current.status).toBe('signedOut');
    expect(result.current.roles).toEqual([]);
    await expect(result.current.apiFetch('/api/v1/patients')).rejects.toBeInstanceOf(NotSignedInError);
  });

  it('after sign-in: sends the token on /me, takes the roles from the SERVER, and returns where to go next', async () => {
    const { result, fetchImpl } = setup();
    let returnTo = '';
    await act(async () => {
      returnTo = await result.current.completeSignIn();
    });
    expect(returnTo).toBe('/reports/upload');
    expect(result.current.status).toBe('signedIn');
    expect(result.current.roles).toEqual(['clinician']);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`${API}/api/v1/me`);
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('attaches the token to later API calls', async () => {
    const { result, fetchImpl } = setup();
    await act(async () => void (await result.current.completeSignIn()));
    await act(async () => void (await result.current.apiFetch('/api/v1/patients', { method: 'GET' })));
    const [url, init] = fetchImpl.mock.calls[1]!;
    expect(url).toBe(`${API}/api/v1/patients`);
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('FAILS (and does not redirect again) when the API refuses a brand-new token: no sign-in loop', async () => {
    const { result, client } = setup({ fetchImpl: fakeFetch({ status: 401 }) });
    await act(async () => {
      await expect(result.current.completeSignIn()).rejects.toThrow();
    });
    expect(result.current.status).toBe('failed');
    expect(result.current.roles).toEqual([]);
    expect(client.signIn).not.toHaveBeenCalled();
  });

  it.each([
    ['an unknown role', { roles: ['superuser'] }],
    ['a roles value that is not a list', { roles: 'admin' }],
    ['a 500 from the API', { status: 500 }],
  ])('fails closed on %s from /me', async (_name, answer) => {
    const { result } = setup({ fetchImpl: fakeFetch(answer) });
    await act(async () => {
      await expect(result.current.completeSignIn()).rejects.toThrow();
    });
    expect(result.current.status).toBe('failed');
    expect(result.current.roles).toEqual([]);
  });

  it('fails when the identity provider callback fails (expired or replayed code)', async () => {
    const client = fakeClient();
    client.completeSignIn.mockRejectedValueOnce(new Error('invalid_grant'));
    const { result } = setup({ client });
    await act(async () => {
      await expect(result.current.completeSignIn()).rejects.toThrow('invalid_grant');
    });
    expect(result.current.status).toBe('failed');
  });

  it('an expired token never leaves the browser: it signs the user out and starts a fresh sign-in', async () => {
    const client = fakeClient({ expiresAt: Math.floor(Date.now() / 1000) + 10 }); // inside the 30s safety margin
    const { result, fetchImpl } = setup({ client });
    await act(async () => void (await result.current.completeSignIn().catch(() => undefined)));
    // /me itself was sent (the callback path does not check expiry); a later call must not be.
    const callsBefore = fetchImpl.mock.calls.length;
    await act(async () => {
      await expect(result.current.apiFetch('/api/v1/patients')).rejects.toBeInstanceOf(SessionEndedError);
    });
    expect(fetchImpl.mock.calls.length).toBe(callsBefore);
    expect(client.signIn).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('signedOut');
    expect(result.current.roles).toEqual([]);
  });

  it('a 401 from the API (revoked, expired, key rotated) signs the user out and starts a fresh sign-in', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ roles: ['clinician'] }), { status: 200 })).mockResolvedValueOnce(new Response('{}', { status: 401 }));
    const { result, client } = setup({ fetchImpl: fetchImpl as never });
    await act(async () => void (await result.current.completeSignIn()));
    await act(async () => {
      await expect(result.current.apiFetch('/api/v1/patients')).rejects.toBeInstanceOf(SessionEndedError);
    });
    expect(client.signIn).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('signedOut');
    expect(result.current.roles).toEqual([]);
  });

  it('sign out forgets everything locally and ends the provider session', async () => {
    const { result, client } = setup();
    await act(async () => void (await result.current.completeSignIn()));
    await act(async () => void (await result.current.signOut()));
    expect(client.signOut).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('signedOut');
    expect(result.current.roles).toEqual([]);
    await expect(result.current.apiFetch('/api/v1/patients')).rejects.toBeInstanceOf(NotSignedInError);
  });

  it('NEVER writes the token (or anything) to localStorage, sessionStorage or cookies', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const { result } = setup();
    await act(async () => void (await result.current.completeSignIn()));
    await act(async () => void (await result.current.apiFetch('/api/v1/patients')));
    expect(setItem).not.toHaveBeenCalled();
    expect(JSON.stringify({ ...localStorage })).not.toContain(TOKEN);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(TOKEN);
    expect(document.cookie).not.toContain(TOKEN);
  });
});
