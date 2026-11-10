import { describe, expect, it } from 'vitest';
import { isStagingApp, usesPublicLanding } from './public-site';

describe('usesPublicLanding', () => {
  it.each(['app.staging.telesphoros.app', 'app.telesphoros.app'])('is true on the deployed app host %s', (host) => {
    expect(usesPublicLanding(host)).toBe(true);
  });

  it.each([
    '127.0.0.1',
    'localhost',
    'telesphoros-frontend-git-branch.vercel.app',
    // The public site itself must never redirect to itself.
    'telesphoros.app',
    // A look-alike domain is not ours.
    'app.nottelesphoros.app',
    'telesphoros.app.example.com',
  ])('is false on %s', (host) => {
    expect(usesPublicLanding(host)).toBe(false);
  });
});

describe('isStagingApp', () => {
  it('is true only on the staging app host', () => {
    expect(isStagingApp('app.staging.telesphoros.app')).toBe(true);
  });

  it.each(['app.telesphoros.app', 'staging.telesphoros.app', 'app.staging.telesphoros.app.example.com'])('is false on %s', (host) => {
    expect(isStagingApp(host)).toBe(false);
  });
});
