import { describe, expect, it } from 'vitest';
import { AuthConfigError, loadAuthConfig } from './authConfig';

const good = {
  VITE_OIDC_AUTHORITY: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_AbCdEf123/',
  VITE_OIDC_CLIENT_ID: 'client123',
  VITE_COGNITO_DOMAIN: 'https://example.auth.us-east-2.amazoncognito.com',
  VITE_API_BASE_URL: 'https://api.telesphoros.app/',
};

describe('loadAuthConfig', () => {
  it('builds the config, trims trailing slashes, and derives the redirect addresses from the site origin', () => {
    expect(loadAuthConfig(good, 'https://app.telesphoros.app', true)).toEqual({
      authority: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_AbCdEf123',
      clientId: 'client123',
      signInDomain: 'https://example.auth.us-east-2.amazoncognito.com',
      apiBaseUrl: 'https://api.telesphoros.app',
      redirectUri: 'https://app.telesphoros.app/auth/callback',
      logoutUri: 'https://app.telesphoros.app/signed-out',
    });
  });

  it('names every missing setting', () => {
    expect(() => loadAuthConfig({}, 'https://x', false)).toThrow(/VITE_OIDC_AUTHORITY.*VITE_OIDC_CLIENT_ID.*VITE_COGNITO_DOMAIN.*VITE_API_BASE_URL/);
    expect(() => loadAuthConfig({ ...good, VITE_OIDC_CLIENT_ID: '  ' }, 'https://x', false)).toThrow(/VITE_OIDC_CLIENT_ID/);
  });

  it('rejects values that are not URLs', () => {
    expect(() => loadAuthConfig({ ...good, VITE_API_BASE_URL: 'api.telesphoros.app' }, 'https://x', false)).toThrow(AuthConfigError);
  });

  it('allows http in development but never in a production build', () => {
    const local = { ...good, VITE_OIDC_AUTHORITY: 'http://127.0.0.1:4010', VITE_API_BASE_URL: 'http://127.0.0.1:3010', VITE_COGNITO_DOMAIN: 'http://127.0.0.1:4010' };
    expect(() => loadAuthConfig(local, 'http://127.0.0.1:4173', false)).not.toThrow();
    expect(() => loadAuthConfig(local, 'https://app.telesphoros.app', true)).toThrow(/https/);
    expect(() => loadAuthConfig({ ...good, VITE_API_BASE_URL: 'http://api.telesphoros.app' }, 'https://x', true)).toThrow(/VITE_API_BASE_URL.*https/);
  });
});
