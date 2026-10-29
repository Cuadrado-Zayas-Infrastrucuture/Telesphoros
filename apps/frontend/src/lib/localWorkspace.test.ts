import type { Role } from '@telesphoros/shared-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { landingAfterSignIn, localWorkspaceAvailable, signedInHome } from './localWorkspace';

const at = (hostname: string) => vi.stubGlobal('location', { hostname });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('the workspace as the local preview main screen (specs/022)', () => {
  it('exists only in a development build served on 127.0.0.1', () => {
    at('127.0.0.1');
    expect(localWorkspaceAvailable()).toBe(true);
    at('localhost');
    expect(localWorkspaceAvailable()).toBe(false);
    at('app.telesphoros.example');
    expect(localWorkspaceAvailable()).toBe(false);
    at('127.0.0.1');
    vi.stubEnv('DEV', false);
    expect(localWorkspaceAvailable()).toBe(false);
  });

  it('in the local preview, signing in from the home page opens the workspace, and deeper paths are kept (WMS-2)', () => {
    at('127.0.0.1');
    expect(landingAfterSignIn('/')).toBe('/local-workspace');
    expect(landingAfterSignIn('/reports/upload')).toBe('/reports/upload');
    expect(landingAfterSignIn('/settings?tab=appearance')).toBe('/settings?tab=appearance');
  });

  it('in the local preview, "Open workspace" goes to the workspace for every role (WMS-2)', () => {
    at('127.0.0.1');
    for (const roles of [['clinician'], ['admin'], []] as Role[][]) expect(signedInHome(roles)).toBe('/local-workspace');
  });

  it('anywhere else, sign-in landing and the home link are unchanged (WMS-1)', () => {
    for (const host of ['app.telesphoros.example', 'localhost']) {
      at(host);
      expect(landingAfterSignIn('/')).toBe('/');
      expect(landingAfterSignIn('/reports')).toBe('/reports');
      expect(signedInHome(['clinician'])).toBe('/reports');
      expect(signedInHome(['admin'] as Role[])).toBe('/usage');
      expect(signedInHome([])).toBe('/settings');
    }
    at('127.0.0.1');
    vi.stubEnv('DEV', false);
    expect(landingAfterSignIn('/')).toBe('/');
    expect(signedInHome(['clinician'])).toBe('/reports');
  });
});
