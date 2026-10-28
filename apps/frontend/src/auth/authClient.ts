import { InMemoryWebStorage, UserManager, WebStorageStateStore } from 'oidc-client-ts';
import type { AuthConfig } from './authConfig';
import { safeReturnTo } from './returnTo';

export interface Session {
  accessToken: string;
  /** Epoch seconds. */
  expiresAt: number;
  returnTo: string;
  /** The `email` claim of the ID token the library has just validated, for display in Settings. Absent when the provider sent none. */
  email?: string;
}

/** The three things the app needs from the identity provider. Tests substitute a fake. */
export interface AuthClient {
  signIn(returnTo: string): Promise<void>;
  completeSignIn(): Promise<Session>;
  signOut(): Promise<void>;
}

/**
 * Sign-in with the authorization-code flow and PKCE (no password or token ever passes through our code on the way in).
 *
 * Where things live:
 *  - Tokens: in memory only. Never localStorage, sessionStorage or cookies. A page reload signs the app
 *    out locally; the identity provider's own session then makes the next sign-in instant.
 *  - The short-lived PKCE verifier and `state`: in sessionStorage, because they must survive the redirect to
 *    the sign-in page and back. They are not tokens and the library deletes them when the callback completes.
 *  - After the callback we keep the access token and ONE claim of the ID token, `email`, so the person can see who they are signed in
 *    as (Settings). The ID token and refresh token themselves are discarded. The email stays in memory: it is never stored, sent to the
 *    API or logged.
 */
export function createAuthClient(
  config: AuthConfig,
  /** Leaves the page. Replaceable so tests can observe the destination. */
  { navigate = (url: string) => window.location.assign(url) }: { navigate?: (url: string) => void } = {},
): AuthClient {
  const manager = new UserManager({
    authority: config.authority,
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: 'openid email',
    userStore: new WebStorageStateStore({ store: new InMemoryWebStorage() }),
    stateStore: new WebStorageStateStore({ store: window.sessionStorage }),
    automaticSilentRenew: false,
    monitorSession: false,
    loadUserInfo: false,
  });

  // React StrictMode runs effects twice in development; a callback can only be redeemed once.
  const inFlight = new Map<string, Promise<Session>>();

  return {
    async signIn(returnTo) {
      await manager.signinRedirect({ state: { returnTo: safeReturnTo(returnTo) } });
    },

    completeSignIn() {
      const key = window.location.href;
      const existing = inFlight.get(key);
      if (existing) return existing;
      const attempt = (async () => {
        const user = await manager.signinRedirectCallback();
        const email = typeof user.profile?.email === 'string' && user.profile.email.length > 0 ? user.profile.email : undefined;
        const session: Session = {
          accessToken: user.access_token,
          expiresAt: user.expires_at ?? Math.floor(Date.now() / 1000) + 60,
          returnTo: safeReturnTo((user.state as { returnTo?: unknown } | undefined)?.returnTo),
          ...(email ? { email } : {}),
        };
        await manager.removeUser(); // drop the ID and refresh tokens the library holds in memory
        return session;
      })();
      inFlight.set(key, attempt);
      return attempt;
    },

    async signOut() {
      await manager.removeUser();
      // Cognito's sign-out endpoint (not the standard end_session one): ends the provider's session too.
      const url = new URL(`${config.signInDomain}/logout`);
      url.searchParams.set('client_id', config.clientId);
      url.searchParams.set('logout_uri', config.logoutUri);
      navigate(url.toString());
    },
  };
}
