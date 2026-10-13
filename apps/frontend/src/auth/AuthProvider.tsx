import { type Role, meDtoSchema } from '@telesphoros/shared-types';
import { createContext, type ReactNode, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { AuthClient } from './authClient';

export type AuthStatus = 'signedOut' | 'signedIn' | 'failed';

export class NotSignedInError extends Error {}
/** Thrown after the app has started a fresh sign-in because the session ended. The caller should just stop. */
export class SessionEndedError extends Error {}
/**
 * Signing in worked but the API refused the account (403): it is not set up for an organization.
 * Trying again cannot help, so the UI says so instead of offering a retry.
 */
export class AccountNotReadyError extends Error {}

export interface AuthContextValue {
  status: AuthStatus;
  roles: Role[];
  signIn(returnTo?: string): Promise<void>;
  /** Finishes the redirect back from sign-in. Resolves with where to go next. */
  completeSignIn(): Promise<string>;
  signOut(): Promise<void>;
  /** `fetch` against the API with the access token attached. */
  apiFetch(path: string, init?: RequestInit): Promise<Response>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** Treat a token as expired a little early so a request never leaves with one about to lapse. */
const EXPIRY_SKEW_SECONDS = 30;

interface AuthProviderProps {
  client: AuthClient;
  apiBaseUrl: string;
  children: ReactNode;
  fetchImpl?: typeof fetch;
}

/**
 * Holds the signed-in state. The access token lives in a ref: in memory only, never in React state
 * that could be logged or serialised, and never in any browser storage. The roles come from the API
 * (`GET /me`), not from decoding the token here: the UI uses them to decide what to SHOW, while the
 * server enforces what is allowed.
 */
export function AuthProvider({ client, apiBaseUrl, children, fetchImpl }: AuthProviderProps) {
  const token = useRef<{ accessToken: string; expiresAt: number } | null>(null);
  const [status, setStatus] = useState<AuthStatus>('signedOut');
  const [roles, setRoles] = useState<Role[]>([]);

  const clear = useCallback(() => {
    token.current = null;
    setRoles([]);
  }, []);

  const currentPath = () => `${window.location.pathname}${window.location.search}`;

  const signIn = useCallback((returnTo?: string) => client.signIn(returnTo ?? currentPath()), [client]);

  /** Sends the request with the token. Never redirects: the caller decides what a refusal means. */
  const send = useCallback(
    async (path: string, init: RequestInit = {}) => {
      const held = token.current;
      if (!held) throw new NotSignedInError('Not signed in');
      const doFetch = fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
      return doFetch(`${apiBaseUrl}${path}`, {
        ...init,
        // After the caller's options on purpose: an authenticated response (patients, reports, results) is never kept in the browser HTTP cache.
        cache: 'no-store',
        headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${held.accessToken}` },
      });
    },
    [apiBaseUrl, fetchImpl],
  );

  const endSessionAndSignInAgain = useCallback(async (message: string): Promise<never> => {
    clear();
    setStatus('signedOut');
    await client.signIn(currentPath());
    throw new SessionEndedError(message);
  }, [clear, client]);

  const apiFetch = useCallback(
    async (path: string, init: RequestInit = {}) => {
      const held = token.current;
      if (!held) throw new NotSignedInError('Not signed in');
      if (held.expiresAt - EXPIRY_SKEW_SECONDS <= Date.now() / 1000) return endSessionAndSignInAgain('Session expired');
      const response = await send(path, init);
      // The server no longer accepts the token (expired, revoked, key rotated): sign in again.
      if (response.status === 401) return endSessionAndSignInAgain('Session rejected');
      return response;
    },
    [endSessionAndSignInAgain, send],
  );

  const completeSignIn = useCallback(async () => {
    try {
      const session = await client.completeSignIn();
      token.current = { accessToken: session.accessToken, expiresAt: session.expiresAt };
      // Deliberately NOT apiFetch: if the API refuses a brand-new token, signing in again would loop
      // forever (the identity provider's session bounces straight back). Report failure instead.
      const response = await send('/api/v1/me');
      if (response.status === 403) throw new AccountNotReadyError('The account is not set up for an organization');
      if (!response.ok) throw new Error('The API did not accept the sign-in');
      setRoles(meDtoSchema.parse(await response.json()).roles);
      setStatus('signedIn');
      return session.returnTo;
    } catch (error) {
      clear();
      if (!(error instanceof SessionEndedError)) setStatus('failed');
      throw error;
    }
  }, [clear, client, send]);

  const signOut = useCallback(async () => {
    clear();
    setStatus('signedOut');
    await client.signOut();
  }, [clear, client]);

  const value = useMemo<AuthContextValue>(
    () => ({ status, roles, signIn, completeSignIn, signOut, apiFetch }),
    [status, roles, signIn, completeSignIn, signOut, apiFetch],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>');
  return value;
}
