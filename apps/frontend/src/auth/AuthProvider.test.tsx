import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { API, fakeClient, fakeFetch, TOKEN, RECOVERY_SCOPE } from '@/test/authTestUtils';
import { bindRecovery, clearRecovery, readRecovery, rememberUpload, uploadSessionCurrent, type RecoverySession } from '@/lib/uploadRecovery';
import { AccountNotReadyError, AuthProvider, NotSignedInError, SessionEndedError, useAuth } from './AuthProvider';

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
afterEach(() => {
  vi.restoreAllMocks();
  clearRecovery();
  window.sessionStorage.clear();
});
function saveInterruption(owner: RecoverySession) {
  const progress = {
    requestId: '11111111-1111-4111-8111-111111111111',
    reportId: '22222222-2222-4222-8222-222222222222',
    facts: { reportType: 'structured' as const, name: 'SYNTHETIC-private.json', sizeBytes: 2, sha256: 'a'.repeat(64) },
  };
  bindRecovery(progress, owner);
  rememberUpload(progress);
}

describe('AuthProvider', () => {
  it('discards legacy unbound recovery metadata before a signed-in page can display it', async () => {
    window.sessionStorage.setItem(
      'telesphoros.upload-recovery.v1',
      JSON.stringify({
        v: 1,
        requestId: '11111111-1111-4111-8111-111111111111',
        reportId: '22222222-2222-4222-8222-222222222222',
        file: { reportType: 'structured', name: 'SYNTHETIC-previous-user.json', sizeBytes: 2, sha256: 'a'.repeat(64) },
        savedAt: new Date().toISOString(),
      }),
    );
    const { result } = setup();
    await act(async () => void (await result.current.completeSignIn()));
    expect(window.sessionStorage.getItem('telesphoros.upload-recovery.v1')).toBeNull();
    window.sessionStorage.clear();
  });

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
    const [url, init] = fetchImpl.mock.calls[2]!;
    expect(url).toBe(`${API}/api/v1/patients`);
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('never lets the browser HTTP cache keep an authenticated API response, even if a caller asks for it', async () => {
    const { result, fetchImpl } = setup();
    await act(async () => void (await result.current.completeSignIn()));
    await act(async () => void (await result.current.apiFetch('/api/v1/patients')));
    await act(async () => void (await result.current.apiFetch('/api/v1/reports', { cache: 'force-cache' })));
    expect(fetchImpl.mock.calls.map(([, init]) => init?.cache)).toEqual(['no-store', 'no-store', 'no-store', 'no-store']);
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

  it('tells "your account has no organization" (403) apart from other failures, and still never loops', async () => {
    const { result, client } = setup({ fetchImpl: fakeFetch({ status: 403 }) });
    await act(async () => {
      await expect(result.current.completeSignIn()).rejects.toBeInstanceOf(AccountNotReadyError);
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
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ roles: ['clinician'] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ recoveryScope: RECOVERY_SCOPE })))
      .mockResolvedValueOnce(new Response('{}', { status: 401 }));
    const { result, client } = setup({ fetchImpl: fetchImpl as never });
    await act(async () => void (await result.current.completeSignIn()));
    await act(async () => {
      await expect(result.current.apiFetch('/api/v1/patients')).rejects.toBeInstanceOf(SessionEndedError);
    });
    expect(client.signIn).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('signedOut');
    expect(result.current.roles).toEqual([]);
  });

  it('sign out forgets a scoped interrupted upload', async () => {
    const { result } = setup();
    await act(async () => void (await result.current.completeSignIn()));
    saveInterruption(result.current.recoverySession!);
    expect(window.sessionStorage.getItem('telesphoros.upload-recovery.v2')).not.toBeNull();
    await act(async () => void (await result.current.signOut()));
    expect(window.sessionStorage.getItem('telesphoros.upload-recovery.v2')).toBeNull();
  });

  it.each([RECOVERY_SCOPE, 'b'.repeat(64)])('a 401 keeps recovery only for the same verified caller/tenant (%s)', async (scope) => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ roles: ['clinician'] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ recoveryScope: RECOVERY_SCOPE })))
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ roles: ['clinician'] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ recoveryScope: scope })));
    const { result } = setup({ fetchImpl: fetchImpl as never });
    await act(async () => void (await result.current.completeSignIn()));
    const first = result.current.recoverySession!;
    saveInterruption(first);
    await act(async () => {
      await expect(result.current.apiFetch('/api/v1/patients')).rejects.toBeInstanceOf(SessionEndedError);
    });
    expect(readRecovery(first)).toBeUndefined();
    expect(window.sessionStorage.getItem('telesphoros.upload-recovery.v2')).not.toBeNull();
    await act(async () => void (await result.current.completeSignIn()));
    expect(!!readRecovery(result.current.recoverySession)).toBe(scope === RECOVERY_SCOPE);
    window.sessionStorage.clear();
  });

  it.each([
    ['answers', undefined],
    ['fails', new TypeError('network down')],
  ])('sign out asks the server to end the sessions first, and leaves even when that call %s', async (_, failure) => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === `${API}/api/v1/me/sign-out`) {
        if (failure) throw failure;
        return new Response(null, { status: 204 });
      }
      return url.endsWith('/recovery-scope') ? new Response(JSON.stringify({ recoveryScope: RECOVERY_SCOPE })) : new Response(JSON.stringify({ roles: ['clinician'] }));
    });
    const { result, client } = setup({ fetchImpl: fetchImpl as never });
    await act(async () => void (await result.current.completeSignIn()));
    await act(async () => void (await result.current.signOut()));
    expect(fetchImpl).toHaveBeenLastCalledWith(`${API}/api/v1/me/sign-out`, expect.objectContaining({ method: 'POST' }));
    expect(client.signOut).toHaveBeenCalledTimes(1);
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

it.each([undefined, 'not-a-scope'])('never mounts an authenticated recovery context without a valid recovery capability (%s)', async (scope) => {
  const fetchImpl = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ roles: ['clinician'] })))
    .mockResolvedValueOnce(new Response(JSON.stringify(scope ? { recoveryScope: scope } : {})));
  const { result } = setup({ fetchImpl: fetchImpl as never });
  await act(async () => {
    await expect(result.current.completeSignIn()).rejects.toThrow();
  });
  expect(result.current.status).toBe('failed');
  expect(result.current.recoverySession).toBeNull();
});

it('a late 401 from the old session cannot sign out the newly verified person', async () => {
  let answer!: (r: Response) => void;
  const fetchImpl = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ roles: ['clinician'] })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ recoveryScope: RECOVERY_SCOPE })))
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    )
    .mockResolvedValueOnce(new Response(JSON.stringify({ roles: ['clinician'] })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ recoveryScope: 'b'.repeat(64) })));
  const { result, client } = setup({ fetchImpl: fetchImpl as never });
  await act(async () => void (await result.current.completeSignIn()));
  const pending = result.current.apiFetch('/api/v1/patients');
  const refused = expect(pending).rejects.toBeInstanceOf(SessionEndedError);
  await act(async () => void (await result.current.completeSignIn()));
  await act(async () => {
    answer(new Response('{}', { status: 401 }));
    await refused;
  });
  expect(result.current.status).toBe('signedIn');
  expect(result.current.recoverySession!.scope).toBe('b'.repeat(64));
  expect(client.signIn).not.toHaveBeenCalled();
});

it('a superseded identity callback cannot replace the newer verified caller', async () => {
  let finish!: (s: { accessToken: string; expiresAt: number; returnTo: string }) => void;
  const client = fakeClient();
  client.completeSignIn.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { result, fetchImpl } = setup({ client });
  const pending = result.current.completeSignIn();
  const refused = expect(pending).rejects.toBeInstanceOf(SessionEndedError);
  await act(async () => void (await result.current.completeSignIn()));
  const current = result.current.recoverySession;
  await act(async () => {
    finish({ accessToken: 'old-synthetic-token', expiresAt: Date.now() / 1000 + 900, returnTo: '/' });
    await refused;
  });
  expect(result.current.status).toBe('signedIn');
  expect(result.current.recoverySession).toBe(current);
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});

it('unmounting retires late upload writers while leaving eligible metadata for reload', async () => {
  const { result, unmount } = setup();
  await act(async () => void (await result.current.completeSignIn()));
  const owner = result.current.recoverySession!;
  saveInterruption(owner);
  const kept = window.sessionStorage.getItem('telesphoros.upload-recovery.v2');
  unmount();
  expect(readRecovery(owner)).toBeUndefined();
  expect(window.sessionStorage.getItem('telesphoros.upload-recovery.v2')).toBe(kept);
});

it('signs in against an older backend and clears all stored recovery on capability rollback', async () => {
  let supported = true;
  const normal = fakeFetch({ roles: ['clinician'] });
  const fetchImpl = vi.fn<typeof fetch>((input, init) =>
    String(input).endsWith('/me/recovery-scope') && !supported ? Promise.resolve(new Response('{}', { status: 404 })) : normal(input, init),
  );
  const { result } = setup({ fetchImpl });
  await act(async () => void (await result.current.completeSignIn()));
  const oldOwner = result.current.recoverySession!;
  saveInterruption(oldOwner);
  window.sessionStorage.setItem('telesphoros.upload-recovery.v1', '{}');
  supported = false;
  await act(async () => void (await result.current.completeSignIn()));
  expect(result.current.status).toBe('signedIn');
  expect(result.current.roles).toEqual(['clinician']);
  expect(result.current.recoverySession!.scope).toBeNull();
  expect(readRecovery(oldOwner)).toBeUndefined();
  expect(window.sessionStorage.getItem('telesphoros.upload-recovery.v1')).toBeNull();
  expect(window.sessionStorage.getItem('telesphoros.upload-recovery.v2')).toBeNull();
  const progress = {
    requestId: '11111111-1111-4111-8111-111111111111',
    reportId: '22222222-2222-4222-8222-222222222222',
    facts: { reportType: 'structured' as const, name: 'synthetic.json', sizeBytes: 2, sha256: 'a'.repeat(64) },
  };
  bindRecovery(progress, result.current.recoverySession!);
  rememberUpload(progress);
  expect(window.sessionStorage.getItem('telesphoros.upload-recovery.v2')).toBeNull();
  await expect(result.current.apiFetch('/api/v1/patients')).resolves.toHaveProperty('status', 200);
  await act(async () => void (await result.current.signOut()));
  expect(uploadSessionCurrent(progress)).toBe(false);
});

it.each([401, 403, 500])('capability HTTP %s fails closed without triggering a sign-in loop', async (status) => {
  const fetchImpl = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ roles: ['clinician'] })))
    .mockResolvedValueOnce(new Response('{}', { status }));
  const { result, client } = setup({ fetchImpl: fetchImpl as never });
  await act(async () => {
    await expect(result.current.completeSignIn()).rejects.toThrow();
  });
  expect(result.current.status).toBe('failed');
  expect(result.current.roles).toEqual([]);
  expect(result.current.recoverySession).toBeNull();
  await expect(result.current.apiFetch('/api/v1/patients')).rejects.toBeInstanceOf(NotSignedInError);
  expect(client.signIn).not.toHaveBeenCalled();
});

it('does not treat a network failure as an older backend', async () => {
  const fetchImpl = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ roles: ['clinician'] })))
    .mockRejectedValueOnce(new TypeError('synthetic network failure'));
  const { result } = setup({ fetchImpl: fetchImpl as never });
  await act(async () => {
    await expect(result.current.completeSignIn()).rejects.toThrow();
  });
  expect(result.current.status).toBe('failed');
  expect(result.current.recoverySession).toBeNull();
});

it('a late capability body cannot replace the newer verified owner', async () => {
  let reading!: () => void;
  const reached = new Promise<void>((resolve) => {
    reading = resolve;
  });
  let finish!: (value: unknown) => void;
  const scopeResponse = new Response('{}');
  scopeResponse.json = () => {
    reading();
    return new Promise((resolve) => {
      finish = resolve;
    });
  };
  const fetchImpl = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ roles: ['clinician'] })))
    .mockResolvedValueOnce(scopeResponse)
    .mockResolvedValueOnce(new Response(JSON.stringify({ roles: ['clinician'] })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ recoveryScope: 'b'.repeat(64) })));
  const { result } = setup({ fetchImpl: fetchImpl as never });
  const old = result.current.completeSignIn();
  const refused = expect(old).rejects.toBeInstanceOf(SessionEndedError);
  await reached;
  await act(async () => void (await result.current.completeSignIn()));
  const current = result.current.recoverySession;
  saveInterruption(current!);
  const kept = window.sessionStorage.getItem('telesphoros.upload-recovery.v2');
  await act(async () => {
    finish({ recoveryScope: RECOVERY_SCOPE });
    await refused;
  });
  expect(result.current.status).toBe('signedIn');
  expect(result.current.recoverySession).toBe(current);
  expect(window.sessionStorage.getItem('telesphoros.upload-recovery.v2')).toBe(kept);
});

it('a stale roles body cannot erase a newer verified session', async () => {
  let reading!: () => void;
  const reached = new Promise<void>((resolve) => {
    reading = resolve;
  });
  let finish!: (value: unknown) => void;
  const stale = new Response('{}');
  stale.json = () => {
    reading();
    return new Promise((resolve) => {
      finish = resolve;
    });
  };
  const fetchImpl = vi
    .fn()
    .mockResolvedValueOnce(stale)
    .mockResolvedValueOnce(new Response(JSON.stringify({ roles: ['clinician'] })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ recoveryScope: 'b'.repeat(64) })));
  const { result } = setup({ fetchImpl: fetchImpl as never });
  const old = result.current.completeSignIn();
  const refused = expect(old).rejects.toBeInstanceOf(SessionEndedError);
  await reached;
  await act(async () => void (await result.current.completeSignIn()));
  const current = result.current.recoverySession;
  saveInterruption(current!);
  const kept = window.sessionStorage.getItem('telesphoros.upload-recovery.v2');
  expect(kept).not.toBeNull();
  await act(async () => {
    finish({ roles: ['admin'] });
    await refused;
  });
  expect(result.current.status).toBe('signedIn');
  expect(result.current.roles).toEqual(['clinician']);
  expect(result.current.recoverySession).toBe(current);
  expect(window.sessionStorage.getItem('telesphoros.upload-recovery.v2')).toBe(kept);
  expect(fetchImpl).toHaveBeenCalledTimes(3);
});
