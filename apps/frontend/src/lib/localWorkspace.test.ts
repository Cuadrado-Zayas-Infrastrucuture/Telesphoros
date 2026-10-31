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
    expect(landingAfterSignIn('/', ['clinician'])).toBe('/local-workspace');
    expect(landingAfterSignIn('/reports/upload', ['clinician'])).toBe('/reports/upload');
    expect(landingAfterSignIn('/settings?tab=appearance', ['clinician'])).toBe('/settings?tab=appearance');
  });

  it('in the local preview, "Open workspace" goes to the workspace for every role (WMS-2)', () => {
    at('127.0.0.1');
    for (const roles of [['clinician'], ['admin'], []] as Role[][]) expect(signedInHome(roles)).toBe('/local-workspace');
  });

  it('anywhere else, writer and clinical read roles land on the chat home, administrators on usage, others on settings (specs/024 CH-1, D6)', () => {
    for (const host of ['app.telesphoros.example', 'localhost']) {
      at(host);
      for (const role of ['clinician', 'reader', 'reviewer'] as Role[]) expect(signedInHome([role])).toBe('/workspace');
      expect(signedInHome(['admin', 'reader'] as Role[])).toBe('/workspace');
      expect(signedInHome(['admin'] as Role[])).toBe('/usage');
      expect(signedInHome([])).toBe('/settings');
    }
  });

  it('anywhere else, signing in from the home page lands on the chat home for clinical roles; deeper paths and other roles are unchanged (CH-1)', () => {
    for (const host of ['app.telesphoros.example', 'localhost']) {
      at(host);
      for (const role of ['clinician', 'reader', 'reviewer'] as Role[]) expect(landingAfterSignIn('/', [role])).toBe('/workspace');
      expect(landingAfterSignIn('/', ['admin'] as Role[])).toBe('/');
      expect(landingAfterSignIn('/', [])).toBe('/');
      expect(landingAfterSignIn('/reports', ['clinician'])).toBe('/reports');
      expect(landingAfterSignIn('/reports/upload', ['clinician'])).toBe('/reports/upload');
    }
    at('127.0.0.1');
    vi.stubEnv('DEV', false);
    expect(landingAfterSignIn('/', ['clinician'])).toBe('/workspace');
    expect(signedInHome(['clinician'])).toBe('/workspace');
  });

  it('the local preview still lands on the local workspace for every role (CH-1)', () => {
    at('127.0.0.1');
    for (const roles of [['clinician'], ['reader'], ['admin'], []] as Role[][]) {
      expect(signedInHome(roles)).toBe('/local-workspace');
      expect(landingAfterSignIn('/', roles)).toBe('/local-workspace');
    }
  });
});
