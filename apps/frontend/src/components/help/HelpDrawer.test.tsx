import { HELP_EN } from '@telesphoros/help-content';
import type { Role } from '@telesphoros/shared-types';
import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RECOVERY_SCOPE, renderApp } from '@/test/authTestUtils';

const page = (data: unknown[]) => ({ data, meta: { page: 1, pageSize: 20, total: data.length, totalPages: data.length ? 1 : 0 } });

function makeFetch(roles: Role[]) {
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    const body = url.includes('/api/v1/patients/')
      ? { id: 'patient-1', label: 'SYN-0042', createdAt: '2026-10-28T12:00:00.000Z', updatedAt: '2026-10-28T12:00:00.000Z', mergedInto: null }
      : url.includes('/api/v1/patients')
        ? page([])
        : url.includes('/api/v1/reports')
          ? page([])
          : url.includes('/api/v1/followups')
            ? { currentActor: 'person-1', items: [], page: 1, hasMore: false, counts: { overdue: 0, today: 0, upcoming: 0, unassigned: 0 } }
            : url.includes('/api/v1/evaluations')
              ? page([])
              : url.endsWith('/api/v1/me/recovery-scope')
                ? { recoveryScope: RECOVERY_SCOPE }
                : { roles };
    return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
  });
}

afterEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.restoreAllMocks();
});

describe('HelpDrawer (spec 051 slice H2)', () => {
  it('opens from the sidebar Help button on screen-contextual articles, shows draft notice, and closes on Escape returning focus', async () => {
    const user = userEvent.setup();
    const fetchMock = makeFetch(['clinician']);
    renderApp('/workspace', { signedInAs: ['clinician'], fetchImpl: fetchMock as unknown as typeof fetch });

    const helpButton = await screen.findByRole('button', { name: 'Help' });
    await user.click(helpButton);

    const drawer = await screen.findByRole('dialog', { name: 'Help' });
    expect(drawer).toHaveAttribute('id', 'help-drawer');
    expect(within(drawer).getByText('What the home page shows')).toBeInTheDocument();
    expect(within(drawer).getByText('What a held result means')).toBeInTheDocument();
    expect(within(drawer).getAllByText('Draft: not yet reviewed by a pharmacist.').length).toBeGreaterThan(0);

    // Native <dialog> dispatches a cancelable "cancel" event when Escape is pressed; jsdom does not synthesize it from keydown.
    fireEvent(drawer, new Event('cancel', { cancelable: true }));
    expect(screen.queryByRole('dialog', { name: 'Help' })).not.toBeInTheDocument();
    expect(helpButton).toHaveFocus();
  });

  it('never shows excluded role articles to an admin', async () => {
    const user = userEvent.setup();
    const fetchMock = makeFetch(['admin']);
    renderApp('/usage', { signedInAs: ['admin'], fetchImpl: fetchMock as unknown as typeof fetch });

    await user.click(await screen.findByRole('button', { name: 'Help' }));
    const drawer = await screen.findByRole('dialog', { name: 'Help' });
    expect(within(drawer).getByText('What each role can do')).toBeInTheDocument();
    expect(within(drawer).queryByText('Attaching a report')).not.toBeInTheDocument();
    expect(within(drawer).queryByText('What a held result means')).not.toBeInTheDocument();

    const search = within(drawer).getByRole('searchbox', { name: 'Search help' });
    await user.type(search, 'attach report');
    expect(within(drawer).queryByText('Attaching a report')).not.toBeInTheDocument();
  });

  it('searches without making any network request or writing to storage, and shows the weak-match banner', async () => {
    const user = userEvent.setup();
    const fetchMock = makeFetch(['clinician']);
    const setItemLocal = vi.spyOn(Storage.prototype, 'setItem');
    renderApp('/workspace', { signedInAs: ['clinician'], fetchImpl: fetchMock as unknown as typeof fetch });

    await user.click(await screen.findByRole('button', { name: 'Help' }));
    const drawer = await screen.findByRole('dialog', { name: 'Help' });
    const search = within(drawer).getByRole('searchbox', { name: 'Search help' });

    const callsBeforeTyping = fetchMock.mock.calls.length;
    setItemLocal.mockClear();

    await user.type(search, 'held quantum spaceship banana toaster');
    expect(fetchMock.mock.calls.length).toBe(callsBeforeTyping);
    expect(setItemLocal).not.toHaveBeenCalled();
    expect(within(drawer).getByText('No article answers that exactly. These are the closest:')).toBeInTheDocument();
  });

  it('refuses patient questions before searching, suppresses matching articles, and preserves query params on patient results links', async () => {
    const user = userEvent.setup();
    const fetchMock = makeFetch(['clinician']);
    renderApp('/patients/patient-1?result=res-1', { signedInAs: ['clinician'], fetchImpl: fetchMock as unknown as typeof fetch });

    await user.click(await screen.findByRole('button', { name: 'Help' }));
    const drawer = await screen.findByRole('dialog', { name: 'Help' });
    const search = within(drawer).getByRole('searchbox', { name: 'Search help' });

    const callsBeforeTyping = fetchMock.mock.calls.length;
    // 'SYN-0042 held result' contains 'held result' which WOULD match 'What a held result means' if search were not gated.
    await user.type(search, 'SYN-0042 held result');

    expect(fetchMock.mock.calls.length).toBe(callsBeforeTyping);
    expect(within(drawer).getByText(HELP_EN.refusal!.body)).toBeInTheDocument();
    expect(within(drawer).queryByText('What a held result means')).not.toBeInTheDocument();

    // Bundled drug + patient question is also refused without network calls.
    await user.clear(search);
    await user.type(search, 'can my patient take clopidogrel');
    expect(fetchMock.mock.calls.length).toBe(callsBeforeTyping);
    expect(within(drawer).getByText(HELP_EN.refusal!.body)).toBeInTheDocument();

    const resultsLink = within(drawer).getByRole('link', { name: /this patient's results/i });
    expect(resultsLink).toHaveAttribute('href', '/patients/patient-1?result=res-1#genomic-profile-heading');

    await user.click(resultsLink);
    expect(screen.queryByRole('dialog', { name: 'Help' })).not.toBeInTheDocument();
  });

  it('stays closed after leaving signed-in routes and returning to the workspace', async () => {
    const user = userEvent.setup();
    const fetchMock = makeFetch(['clinician']);
    renderApp('/workspace', { signedInAs: ['clinician'], fetchImpl: fetchMock as unknown as typeof fetch });

    await user.click(await screen.findByRole('button', { name: 'Help' }));
    expect(await screen.findByRole('dialog', { name: 'Help' })).toBeInTheDocument();

    // Navigate to public landing (sidebar becomes false), then return to workspace (sidebar becomes true).
    const brandLink = document.querySelector<HTMLAnchorElement>('header.workspace-navigation a.workspace-brand')!;
    fireEvent.click(brandLink);

    const openWorkspace = await screen.findByRole('link', { name: 'Open workspace' });
    expect(screen.queryByRole('dialog', { name: 'Help' })).not.toBeInTheDocument();

    await user.click(openWorkspace);
    await screen.findByRole('button', { name: 'Help' });
    expect(screen.queryByRole('dialog', { name: 'Help' })).not.toBeInTheDocument();
  });
});
