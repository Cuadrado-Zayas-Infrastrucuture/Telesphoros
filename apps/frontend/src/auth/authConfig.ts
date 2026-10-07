export interface AuthConfig {
  /** The OpenID Connect issuer (Cognito: https://cognito-idp.<region>.amazonaws.com/<pool id>). */
  authority: string;
  clientId: string;
  /** Cognito's sign-in domain; used for sign-out. */
  signInDomain: string;
  apiBaseUrl: string;
  redirectUri: string;
  logoutUri: string;
}

export class AuthConfigError extends Error {}

const REQUIRED = ['VITE_OIDC_AUTHORITY', 'VITE_OIDC_CLIENT_ID', 'VITE_COGNITO_DOMAIN', 'VITE_API_BASE_URL'] as const;

/**
 * Reads and validates the build-time settings. A wrong setting stops the app with a clear message
 * instead of failing mysteriously at sign-in. Production builds accept https:// only.
 */
export function loadAuthConfig(env: Record<string, unknown>, origin: string, production: boolean): AuthConfig {
  const missing = REQUIRED.filter((name) => typeof env[name] !== 'string' || (env[name] as string).trim() === '');
  if (missing.length > 0) throw new AuthConfigError(`Missing configuration: ${missing.join(', ')}`);

  const value = (name: (typeof REQUIRED)[number]) => (env[name] as string).trim().replace(/\/+$/, '');
  for (const name of ['VITE_OIDC_AUTHORITY', 'VITE_COGNITO_DOMAIN', 'VITE_API_BASE_URL'] as const) {
    let url: URL;
    try {
      url = new URL(value(name));
    } catch {
      throw new AuthConfigError(`${name} is not a valid URL`);
    }
    if (production && url.protocol !== 'https:') throw new AuthConfigError(`${name} must be https:// in a production build`);
  }

  return {
    authority: value('VITE_OIDC_AUTHORITY'),
    clientId: value('VITE_OIDC_CLIENT_ID'),
    signInDomain: value('VITE_COGNITO_DOMAIN'),
    apiBaseUrl: value('VITE_API_BASE_URL'),
    redirectUri: `${origin}/auth/callback`,
    logoutUri: `${origin}/signed-out`,
  };
}
