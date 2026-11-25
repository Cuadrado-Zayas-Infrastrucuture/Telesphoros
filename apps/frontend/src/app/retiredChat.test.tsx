import { screen, waitFor } from '@testing-library/react';
import type { Role } from '@telesphoros/shared-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { preferenceStorage } from '@/lib/storageConsent';
import { RECOVERY_SCOPE, renderApp } from '@/test/authTestUtils';

// Spec 052 RC1b: the chat is gone. Help (spec 051) answers how-to questions and Attach a report (/reports/upload) attaches reports. Hand-written
// expectations from the specification's rules RC-1, RC-5 and RC-6; the sidebar's own entries are in WorkspaceSidebar.test.

const EMPTY_COUNTS = { overdue: 0, today: 0, upcoming: 0, unassigned: 0 };
const EMPTY_PAGE = { data: [], meta: { page: 1, pageSize: 20, total: 0, totalPages: 0 } };
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });

function api(roles: Role[]) {
  return vi.fn<typeof fetch>(async (input) => {
    const at = new URL(String(input), 'http://synthetic');
    if (at.pathname.endsWith('/me/recovery-scope')) return json({ recoveryScope: RECOVERY_SCOPE });
    if (at.pathname === '/api/v1/followups') return json({ currentActor: 'person-1', items: [], page: 1, hasMore: false, counts: EMPTY_COUNTS });
    if (at.pathname === '/api/v1/evaluations' || at.pathname.includes('/patients') || at.pathname.includes('/reports')) return json(EMPTY_PAGE);
    return json({ roles });
  });
}
const open = (path: string, roles: Role[]) => renderApp(path, { signedInAs: roles, fetchImpl: api(roles) as unknown as typeof fetch });

afterEach(() => {
  window.localStorage.clear();
  preferenceStorage.choose(true);
  vi.restoreAllMocks();
});

describe('the retired chat (spec 052)', () => {
  it('sends an old /chat link or bookmark to the home, never to an error (RC-5, RC-D2)', async () => {
    const { router } = open('/chat', ['clinician']);
    expect(await screen.findByRole('heading', { level: 1, name: 'Your worklist' })).toBeVisible();
    expect(router.state.location.pathname).toBe('/workspace');
    expect(screen.queryByRole('heading', { name: /not found/i })).toBeNull();
  });

  it('does the same for a member with no role, who is told there is no work to show', async () => {
    const { router } = open('/chat', []);
    expect(await screen.findByText('Your account has no clinical role, so there is no work to show here.')).toBeVisible();
    expect(router.state.location.pathname).toBe('/workspace');
  });

  it('leaves no box for typed questions on the home or the upload page (RC-1)', async () => {
    const home = open('/workspace', ['clinician']);
    await screen.findByRole('heading', { level: 1, name: 'Your worklist' });
    expect(screen.queryByRole('textbox', { name: 'Question' })).toBeNull();
    home.unmount();
    open('/reports/upload', ['clinician']);
    await screen.findByRole('heading', { level: 1, name: 'Attach a report' });
    expect(screen.queryByRole('textbox', { name: 'Question' })).toBeNull();
  });

  // Moved from the chat's own tests (WorkspacePage.test.tsx, removed): where signing in from the home page lands.
  it('signing in from the home page lands on /workspace for a clinical role, and an administrator stays on the home page (spec 049 W-D5)', async () => {
    const clinician = open('/', ['clinician']);
    await screen.findByRole('heading', { level: 1, name: 'Your worklist' });
    expect(clinician.router.state.location.pathname).toBe('/workspace');
    clinician.unmount();
    const admin = open('/', ['admin']);
    await waitFor(() => expect(admin.client.completeSignIn).toHaveBeenCalled());
    await screen.findByRole('main');
    await waitFor(() => expect(admin.router.state.location.pathname).toBe('/'));
  });
});
