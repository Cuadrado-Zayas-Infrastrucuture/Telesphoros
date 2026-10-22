import { clearRecovery, endRecoverySession, startRecoverySession, type RecoverySession } from '@/lib/uploadRecovery';
import { type Role, meDtoSchema, recoveryScopeDtoSchema } from '@telesphoros/shared-types';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
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
  recoverySession: RecoverySession | null;
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
  const epoch = useRef(0);
  const recovery = useRef<RecoverySession | null>(null);
  const [recoverySession, setRecoverySession] = useState<RecoverySession | null>(null);
  const [status, setStatus] = useState<AuthStatus>('signedOut');
  const [roles, setRoles] = useState<Role[]>([]);
  useEffect(() => () => {
    epoch.current += 1;
    endRecoverySession(recovery.current);
    recovery.current = null;
    token.current = null;
  }, []);

  const clear = useCallback(() => {
    epoch.current += 1;
    endRecoverySession(recovery.current);
    recovery.current = null;
    setRecoverySession(null);
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
      // A late response from an older sign-in must not be delivered to, or sign out, the current person.
      if (token.current !== held) throw new SessionEndedError('Request belongs to an ended session');
      // The server no longer accepts the token (expired, revoked, key rotated): sign in again.
      if (response.status === 401) return endSessionAndSignInAgain('Session rejected');
      return response;
    },
    [endSessionAndSignInAgain, send],
  );

  const completeSignIn = useCallback(async () => {
    clear();
    setStatus('signedOut');
    const attempt = epoch.current;
    try {
      const session = await client.completeSignIn();
      if (epoch.current !== attempt) throw new SessionEndedError('Sign-in superseded');
      const held = { accessToken: session.accessToken, expiresAt: session.expiresAt };
      token.current = held;
      // Deliberately NOT apiFetch: if the API refuses a brand-new token, signing in again would loop
      // forever (the identity provider's session bounces straight back). Report failure instead.
      const response = await send('/api/v1/me');
      if (epoch.current !== attempt || token.current !== held) throw new SessionEndedError('Sign-in superseded');
      if (response.status === 403) throw new AccountNotReadyError('The account is not set up for an organization');
      if (!response.ok) throw new Error('The API did not accept the sign-in');
      const me = meDtoSchema.parse(await response.json());
      if (epoch.current !== attempt || token.current !== held) throw new SessionEndedError('Sign-in superseded');
      // A missing capability on an older backend disables reload recovery, not ordinary sign-in.
      // Refusals, outages and malformed successful replies remain failures; never invent a persistent binding.
      const scopeResponse = await send('/api/v1/me/recovery-scope');
      if (epoch.current !== attempt || token.current !== held) throw new SessionEndedError('Sign-in superseded');
      if (scopeResponse.status === 403) throw new AccountNotReadyError('The account is not set up for an organization');
      if (!scopeResponse.ok && scopeResponse.status !== 404) throw new Error('The API did not accept the recovery binding');
      const scope = scopeResponse.status === 404 ? undefined : recoveryScopeDtoSchema.parse(await scopeResponse.json()).recoveryScope;
      if (epoch.current !== attempt || token.current !== held) throw new SessionEndedError('Sign-in superseded');
      const owner = startRecoverySession(scope);
      recovery.current = owner;
      setRecoverySession(owner);
      setRoles(me.roles);
      setStatus('signedIn');
      return session.returnTo;
    } catch (error) {
      if (epoch.current === attempt) {
        clear();
        if (!(error instanceof SessionEndedError)) setStatus('failed');
      }
      throw error;
    }
  }, [clear, client, send]);

  const signOut = useCallback(async () => {
    // The server refuses this person's older tokens before the browser leaves. If that call fails, this browser still signs out, and the
    // access token lapses within its 15-minute lifetime. `send`, not `apiFetch`: a 401 there would start a new sign-in instead of ending this one.
    await send('/me/sign-out', { method: 'POST' }).catch(() => undefined);
    clear();
    clearRecovery(); // an interrupted upload is not carried into another person's session on this tab
    setStatus('signedOut');
    await client.signOut();
  }, [clear, client, send]);

  const value = useMemo<AuthContextValue>(
    () => ({ status, roles, recoverySession, signIn, completeSignIn, signOut, apiFetch }),
    [status, roles, recoverySession, signIn, completeSignIn, signOut, apiFetch],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>');
  return value;
}
