import { preferenceStorage } from '@/lib/storageConsent';
import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Role } from '@telesphoros/shared-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RECOVERY_SCOPE, renderApp } from '@/test/authTestUtils';

const sidebar = () => document.querySelector<HTMLElement>('header.workspace-navigation');
/** The sidebar's navigation, once sign-in has finished (before that, the signed-out header has its own "Primary" navigation). */
const primary = async () => {
  await screen.findByRole('button', { name: /^(Collapse|Expand) sidebar$/ });
  return within(screen.getByRole('navigation', { name: 'Primary' }));
};
/** The links above Recents (Recents loads on its own; its rows are checked separately). */
const linkNames = async () =>
  (await primary())
    .getAllByRole('link')
    .filter((link) => !link.closest('.workspace-recents'))
    .map((link) => link.textContent);
/** The panel's items in order: links by their text, Follow-ups and Recents by their names (specs/034 D1). */
const panelItems = async () => {
  await primary();
  return [...screen.getByRole('navigation', { name: 'Primary' }).querySelectorAll<HTMLElement>('[data-panel-item]')].map((item) => item.dataset.panelItem);
};

const PATIENT = { id: '0f8fad5b-d9cb-469f-a165-70867728950e', label: 'SYN-004', createdAt: '2026-10-28T12:00:00.000Z', updatedAt: '2026-10-28T12:00:00.000Z', mergedInto: null };
const REPORT = {
  id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  patientId: PATIENT.id,
  type: 'structured',
  filename: 'SYN-004-cyp2c19.json',
  sizeBytes: 120,
  status: 'processed',
  fileUploaded: true,
  contentType: 'application/json',
  sha256: 'a'.repeat(64),
  createdAt: '2026-10-28T12:00:00.000Z',
  updatedAt: '2026-10-28T12:00:00.000Z',
};
const page = (data: unknown[]) => ({ data, meta: { page: 1, pageSize: 20, total: data.length, totalPages: data.length ? 1 : 0 } });
function api(roles: Role[]) {
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    const body = url.includes('/api/v1/patients')
      ? page([PATIENT])
      : url.includes('/api/v1/reports')
        ? page([REPORT])
        : url.endsWith('/api/v1/me/recovery-scope')
          ? { recoveryScope: RECOVERY_SCOPE }
          : { roles };
    return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
  });
}
const open = (path: string, roles: Role[]) => renderApp(path, { signedInAs: roles, fetchImpl: api(roles) as unknown as typeof fetch });

afterEach(() => {
  window.localStorage.clear();
  preferenceStorage.choose(true);
  vi.restoreAllMocks();
});

describe('one sidebar for every signed-in page (specs/018-unified-sidebar)', () => {
  it('frames Settings with the sidebar, holding the feature panel for a clinician', async () => {
    open('/settings', ['clinician']);
    expect(await linkNames()).toEqual(['New chat', 'Patients', 'Reports']);
    expect(sidebar()).not.toBeNull();
  });

  it('in the local preview, puts "Workspace" first among the destinations, linking to the one-screen workspace (specs/022, specs/034 D1)', async () => {
    vi.stubGlobal('location', { ...window.location, hostname: '127.0.0.1' });
    try {
      open('/settings', ['clinician']);
      const nav = await primary();
      expect(nav.getAllByRole('link').map((link) => link.textContent)).toEqual(['New chat', 'Workspace', 'Chat preview', 'Patients', 'Reports']);
      expect(nav.getByRole('link', { name: 'Workspace' })).toHaveAttribute('href', '/local-workspace');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('gives an administrator Usage and no clinical link that would lead to "no access"', async () => {
    open('/usage', ['admin']);
    expect(await linkNames()).toEqual(['New chat', 'Usage']);
    expect(await panelItems()).toEqual(['New chat', 'Usage']);
  });

  it('keeps the site header on the public landing page, even when signed in', async () => {
    open('/', ['clinician']);
    await screen.findByRole('main');
    expect(sidebar()).toBeNull();
  });

  it('collapses to icons and back, keeps every link name for assistive technology, and remembers the choice', async () => {
    const { unmount } = open('/settings', ['clinician']);
    await primary();
    await userEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    expect(sidebar()).toHaveClass('is-collapsed');
    expect(window.localStorage.getItem('telesphoros.sidebar')).toBe('collapsed');
    expect((await primary()).getByRole('link', { name: 'Patients' })).toHaveAttribute('title', 'Patients');
    expect(screen.getByRole('button', { name: 'Account, clinician' })).toHaveAttribute('title', 'Account, clinician');
    unmount();

    open('/settings', ['clinician']);
    await primary();
    expect(sidebar()).toHaveClass('is-collapsed');
    await userEvent.click(screen.getByRole('button', { name: 'Expand sidebar' }));
    expect(sidebar()).not.toHaveClass('is-collapsed');
    expect(window.localStorage.getItem('telesphoros.sidebar')).toBeNull();
  });

  it('starts expanded, and still collapses, when browser storage is blocked', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    open('/settings', ['reader']);
    await primary();
    expect(sidebar()).not.toHaveClass('is-collapsed');
    await userEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    expect(sidebar()).toHaveClass('is-collapsed');
  });
});

describe('the sidebar width (specs/034 D8)', () => {
  // The preference store keeps an in-memory copy when storage is blocked; start each test expanded at the default width.
  beforeEach(() => {
    preferenceStorage.write('telesphoros.sidebar', null);
    preferenceStorage.write('telesphoros.sidebar-width', null);
  });
  const handle = () => screen.getByRole('slider', { name: 'Sidebar width' });
  const width = () => sidebar()!.style.getPropertyValue('--size-sidebar');

  it('drags with the mouse, within bounds, and keeps the width in this browser once the drag ends', async () => {
    const { unmount } = open('/settings', ['clinician']);
    await primary();
    expect(width()).toBe('17rem');
    fireEvent.pointerDown(handle(), { button: 0, clientX: 272, pointerId: 1 });
    fireEvent.pointerMove(handle(), { clientX: 336, pointerId: 1 });
    expect(width()).toBe('21rem');
    expect(window.localStorage.getItem('telesphoros.sidebar-width')).toBeNull();
    fireEvent.pointerMove(handle(), { clientX: 2000, pointerId: 1 });
    expect(width()).toBe('24rem');
    fireEvent.pointerUp(handle(), { clientX: 2000, pointerId: 1 });
    expect(window.localStorage.getItem('telesphoros.sidebar-width')).toBe('24');
    unmount();

    open('/settings', ['clinician']);
    await primary();
    expect(width()).toBe('24rem');
    expect(handle()).toHaveAttribute('aria-valuenow', '24');
  });

  it('moves with the arrow keys, Home and End, and a double click restores the default', async () => {
    open('/settings', ['clinician']);
    await primary();
    fireEvent.keyDown(handle(), { key: 'ArrowLeft' });
    expect(width()).toBe('16.5rem');
    fireEvent.keyDown(handle(), { key: 'Home' });
    expect(width()).toBe('14rem');
    fireEvent.keyDown(handle(), { key: 'ArrowLeft' });
    expect(handle()).toHaveAttribute('aria-valuenow', '14');
    fireEvent.keyDown(handle(), { key: 'End' });
    expect(window.localStorage.getItem('telesphoros.sidebar-width')).toBe('24');
    fireEvent.doubleClick(handle());
    expect(width()).toBe('17rem');
    expect(window.localStorage.getItem('telesphoros.sidebar-width')).toBeNull();
  });

  it('ignores a stored width that is out of bounds or not a number, and has no handle while collapsed', async () => {
    for (const stored of ['99', '2', 'wide']) {
      window.localStorage.setItem('telesphoros.sidebar-width', stored);
      const { unmount } = open('/settings', ['clinician']);
      await primary();
      expect(width(), stored).toBe('17rem');
      unmount();
    }
    open('/settings', ['clinician']);
    await primary();
    await userEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    expect(screen.queryByRole('slider', { name: 'Sidebar width' })).toBeNull();
  });
});

describe('the feature panel (specs/034 D1, D3, D4; specs/024 D6)', () => {
  it('lists, in order, only the items the role may use', async () => {
    const cases: [Role[], string[]][] = [
      [['clinician'], ['New chat', 'Patients', 'Reports', 'Follow-ups', 'Recents']],
      [['reader'], ['New chat', 'Patients', 'Reports', 'Recents']],
      [['reviewer'], ['New chat', 'Patients', 'Reports', 'Follow-ups', 'Recents']],
      [['admin'], ['New chat', 'Usage']],
      [
        ['admin', 'clinician'],
        ['New chat', 'Patients', 'Reports', 'Follow-ups', 'Usage', 'Recents'],
      ],
      [[], ['New chat']],
    ];
    for (const [roles, expected] of cases) {
      const { unmount } = open('/settings', roles);
      expect(await panelItems(), roles.join('+') || 'no role').toEqual(expected);
      unmount();
    }
  });

  it('asks for its recent reports newest first, so the latest are on top', async () => {
    const fetchImpl = api(['clinician']);
    renderApp('/settings', { signedInAs: ['clinician'], fetchImpl: fetchImpl as unknown as typeof fetch });
    await panelItems();
    const urls = () => fetchImpl.mock.calls.map(([input]) => String(input));
    await vi.waitFor(() => {
      expect(urls().some((url) => url.endsWith('/api/v1/reports?page=1&pageSize=20&order=desc'))).toBe(true);
    });
  });

  it('points each link where the old pages are, New chat at /workspace (specs/024 D7) and Patients at its page (D2)', async () => {
    open('/settings', ['admin', 'clinician']);
    const nav = await primary();
    const href = (name: string) => nav.getByRole('link', { name }).getAttribute('href');
    expect({ chat: href('New chat'), patients: href('Patients'), reports: href('Reports'), usage: href('Usage') }).toEqual({
      chat: '/workspace',
      patients: '/patients',
      reports: '/reports',
      usage: '/usage',
    });
  });

  it('shows the recent reports one line each, the status as a word in color, and each row opens its report on the Reports page (D3)', async () => {
    open('/settings', ['clinician']);
    await primary();
    const recents = await screen.findByRole('list', { name: 'Recent reports' });
    const row = await within(recents).findByRole('link', { name: /^SYN-004-cyp2c19\s*,\s*Processed$/ });
    expect(row).toHaveAttribute('title', 'SYN-004-cyp2c19.json');
    expect(within(row).getByText('Processed')).toHaveClass('text-success');
    expect(screen.queryByRole('list', { name: 'Patients' })).toBeNull();
    await userEvent.click(row);
    const details = await screen.findByRole('region', { name: 'Report details' });
    expect(within(details).getAllByText('SYN-004-cyp2c19.json').length).toBeGreaterThan(0);
  });

  it('asks for neither list when the role has no clinical read access', async () => {
    const { fetchImpl } = open('/usage', ['admin']);
    await primary();
    expect(screen.queryByRole('list', { name: 'Recent reports' })).toBeNull();
    expect(fetchImpl.mock.calls.some(([input]) => /\/api\/v1\/(reports|patients)/.test(String(input)))).toBe(false);
  });

  it('puts the account at the bottom; its menu holds Settings and Sign out and closes on Escape (D4)', async () => {
    open('/reports', ['clinician']);
    await primary();
    const account = document.querySelector<HTMLElement>('.workspace-account')!;
    expect(account.compareDocumentPosition(screen.getByRole('navigation', { name: 'Primary' })) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    const toggle = within(account).getByRole('button', { name: 'Account, clinician' });
    expect(within(account).queryByRole('link', { name: 'Settings' })).toBeNull();
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(within(account).getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings');
    expect(within(account).getByRole('button', { name: 'Sign out' })).toBeVisible();
    fireEvent.keyDown(within(account).getByRole('link', { name: 'Settings' }), { key: 'Escape' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveFocus();
  });

  it('gives quick settings in the account menu: the theme in one click, and the storage choice under Learn more (D9, D10)', async () => {
    open('/reports', ['clinician']);
    await primary();
    const account = document.querySelector<HTMLElement>('.workspace-account')!;
    await userEvent.click(within(account).getByRole('button', { name: 'Account, clinician' }));
    const theme = within(account).getByRole('radiogroup', { name: 'Theme' });
    expect(within(theme).getByRole('radio', { name: 'Auto (match this device)' })).toBeChecked();
    await userEvent.click(within(theme).getByRole('radio', { name: 'Dark' }));
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    expect(within(theme).getByRole('radio', { name: 'Dark' })).toBeChecked();
    await userEvent.click(within(theme).getByRole('radio', { name: 'Auto (match this device)' }));
    expect(within(account).queryByRole('button', { name: 'Cookie settings' })).toBeNull();
    await userEvent.click(within(account).getByRole('button', { name: 'Learn more' }));
    await userEvent.click(within(account).getByRole('button', { name: 'Cookie settings' }));
    expect(within(account).getByRole('button', { name: 'Account, clinician' })).toHaveAttribute('aria-expanded', 'false');
    expect(await screen.findByRole('dialog', { name: /cookie|storage/i })).toBeVisible();
  });

  it('links help, feedback, bug reports, the changelog and the policies to the repository, each in a new tab (D10)', async () => {
    open('/reports', ['clinician']);
    await primary();
    const account = document.querySelector<HTMLElement>('.workspace-account')!;
    await userEvent.click(within(account).getByRole('button', { name: 'Account, clinician' }));
    // Closed, the menu is short: Help and Learn more hold the links until opened (D11).
    expect(within(account).queryByRole('link', { name: /^Get help/ })).toBeNull();
    await userEvent.click(within(account).getByRole('button', { name: 'Help' }));
    await userEvent.click(within(account).getByRole('button', { name: 'Learn more' }));
    const repo = 'https://github.com/Cuadrado-Zayas-Infrastrucuture/Telesphoros';
    const expected: [RegExp, string][] = [
      [/^Get help/, `${repo}/blob/main/SUPPORT.md`],
      [/^Send feedback/, `${repo}/issues/new?template=feature_request.yml`],
      [/^Report a bug/, `${repo}/issues/new?template=bug_report.yml`],
      [/^View changelog/, `${repo}/blob/main/CHANGELOG.md`],
      [/^Security policy/, `${repo}/blob/main/SECURITY.md`],
      [/^Code of conduct/, `${repo}/blob/main/CODE_OF_CONDUCT.md`],
      [/^License/, `${repo}/blob/main/LICENSE`],
    ];
    for (const [name, href] of expected) {
      const link = within(account).getByRole('link', { name });
      expect(link).toHaveAttribute('href', href);
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
      expect(link).toHaveAccessibleName(expect.stringMatching(/\(opens in a new tab\)$/));
    }
    // Language says what is true: English only, Spanish not yet.
    await userEvent.click(within(account).getByRole('button', { name: /^Language/ }));
    expect(within(account).getByText('English', { selector: 'li' })).toBeVisible();
    expect(within(account).getByText('Español: aún no disponible')).toHaveAttribute('lang', 'es');
  });

  it('moves focus into the menu when it opens, and the arrow keys move between its items (D10)', async () => {
    open('/reports', ['clinician']);
    await primary();
    const account = document.querySelector<HTMLElement>('.workspace-account')!;
    await userEvent.click(within(account).getByRole('button', { name: 'Account, clinician' }));
    expect(within(account).getByRole('link', { name: 'Settings' })).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    expect(within(account).getByRole('button', { name: /^Language/ })).toHaveFocus();
    await userEvent.keyboard('{ArrowUp}{ArrowUp}');
    expect(within(account).getByRole('button', { name: 'Sign out' })).toHaveFocus();
  });

  it('on a phone the menu button opens it, and Escape closes it and returns focus to the button', async () => {
    open('/settings', ['clinician']);
    await primary();
    const toggle = screen.getByRole('button', { name: 'Workspace navigation' });
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    screen.getByRole('link', { name: 'Reports' }).focus();
    fireEvent.keyDown(screen.getByRole('link', { name: 'Reports' }), { key: 'Escape' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveFocus();
  });
});
