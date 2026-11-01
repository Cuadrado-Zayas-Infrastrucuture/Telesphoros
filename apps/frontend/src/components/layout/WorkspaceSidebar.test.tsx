import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Role } from '@telesphoros/shared-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RECOVERY_SCOPE, renderApp } from '@/test/authTestUtils';

const sidebar = () => document.querySelector<HTMLElement>('header.workspace-navigation');
/** The sidebar's navigation, once sign-in has finished (before that, the signed-out header has its own "Primary" navigation). */
const primary = async () => {
  await screen.findByRole('button', { name: /^(Collapse|Expand) sidebar$/ });
  return within(screen.getByRole('navigation', { name: 'Primary' }));
};
const linkNames = async () => (await primary()).getAllByRole('link').map((link) => link.textContent);
/** The feature panel's items in order: links by their text, sections by their heading (specs/024 D2). */
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
  vi.restoreAllMocks();
});

describe('one sidebar for every signed-in page (specs/018-unified-sidebar)', () => {
  it('frames Settings with the sidebar, holding the feature panel for a clinician', async () => {
    open('/settings', ['clinician']);
    expect(await linkNames()).toEqual(['New chat', 'Upload report', 'All reports', 'Settings']);
    expect(sidebar()).not.toBeNull();
  });

  it('in the local preview, puts "Workspace" first, linking to the one-screen workspace (specs/022)', async () => {
    vi.stubGlobal('location', { ...window.location, hostname: '127.0.0.1' });
    try {
      open('/settings', ['clinician']);
      const nav = await primary();
      expect(nav.getAllByRole('link').map((link) => link.textContent)).toEqual(['Workspace', 'Chat preview', 'New chat', 'Upload report', 'All reports', 'Settings']);
      expect(nav.getByRole('link', { name: 'Workspace' })).toHaveAttribute('href', '/local-workspace');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('gives an administrator Usage and no clinical link that would lead to "no access"', async () => {
    open('/usage', ['admin']);
    expect(await linkNames()).toEqual(['New chat', 'Usage', 'Settings']);
    expect(await panelItems()).toEqual(['New chat', 'Usage', 'Settings']);
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
    const settings = (await primary()).getByRole('link', { name: 'Settings' });
    expect(settings).toHaveAttribute('title', 'Settings');
    // CSS shows one of the two Sign out controls (jsdom applies no CSS; the browser suite checks which is visible).
    expect(document.querySelector('.workspace-account-compact')).toHaveAccessibleName('Sign out');
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

describe('the feature panel (specs/024 D2, D6, CH-2)', () => {
  it('lists, in order, only the items the role may use', async () => {
    const cases: [Role[], string[]][] = [
      [['clinician'], ['New chat', 'Past reports', 'Patients', 'Upload report', 'All reports', 'Settings']],
      [['reader'], ['New chat', 'Past reports', 'Patients', 'All reports', 'Settings']],
      [['reviewer'], ['New chat', 'Past reports', 'Patients', 'All reports', 'Settings']],
      [['admin'], ['New chat', 'Usage', 'Settings']],
      [
        ['admin', 'clinician'],
        ['New chat', 'Past reports', 'Patients', 'Upload report', 'All reports', 'Usage', 'Settings'],
      ],
      [[], ['New chat', 'Settings']],
    ];
    for (const [roles, expected] of cases) {
      const { unmount } = open('/settings', roles);
      expect(await panelItems(), roles.join('+') || 'no role').toEqual(expected);
      unmount();
    }
  });

  it('asks for newest first for its patients and its past reports, so the latest are on top', async () => {
    const fetchImpl = api(['clinician']);
    renderApp('/settings', { signedInAs: ['clinician'], fetchImpl: fetchImpl as unknown as typeof fetch });
    await panelItems();
    const urls = () => fetchImpl.mock.calls.map(([input]) => String(input));
    await vi.waitFor(() => {
      expect(urls().some((url) => url.endsWith('/api/v1/patients?page=1&pageSize=20&order=desc'))).toBe(true);
      expect(urls().some((url) => url.endsWith('/api/v1/reports?page=1&pageSize=20&order=desc'))).toBe(true);
    });
  });

  it('points each link where the old pages are, and New chat at /workspace (D7)', async () => {
    open('/settings', ['admin', 'clinician']);
    const nav = await primary();
    const href = (name: string) => nav.getByRole('link', { name }).getAttribute('href');
    expect({ chat: href('New chat'), upload: href('Upload report'), all: href('All reports'), usage: href('Usage'), settings: href('Settings') }).toEqual({
      chat: '/workspace',
      upload: '/reports/upload',
      all: '/reports',
      usage: '/usage',
      settings: '/settings',
    });
  });

  it('shows the first page of past reports with the status as a word in color, and the first page of patient labels only', async () => {
    open('/settings', ['clinician']);
    const nav = await primary();
    const past = await screen.findByRole('list', { name: 'Past reports' });
    expect(await within(past).findByText('SYN-004-cyp2c19.json')).toBeVisible();
    expect(within(past).getByText('Processed')).toHaveClass('text-success');
    const patients = nav.getByRole('list', { name: 'Patients' });
    expect(await within(patients).findByText('SYN-004')).toBeVisible();
    expect(within(patients).queryAllByRole('link')).toHaveLength(0);
  });

  it('asks for neither list when the role has no clinical read access', async () => {
    const { fetchImpl } = open('/usage', ['admin']);
    await primary();
    expect(screen.queryByRole('list', { name: 'Past reports' })).toBeNull();
    expect(fetchImpl.mock.calls.some(([input]) => /\/api\/v1\/(reports|patients)/.test(String(input)))).toBe(false);
  });

  it('puts the account and Sign out at the bottom', async () => {
    open('/settings', ['clinician']);
    await primary();
    const account = document.querySelector<HTMLElement>('.workspace-account')!;
    expect(within(account).getAllByRole('button', { name: 'Sign out', hidden: true }).length).toBeGreaterThan(0);
    expect(account.compareDocumentPosition(screen.getByRole('navigation', { name: 'Primary' })) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  });

  describe('Add patient (CH-9, D2a)', () => {
    const NEW = { ...PATIENT, id: '1a8fad5b-d9cb-469f-a165-70867728950f', label: 'SYN-777' };
    /** The panel's API plus patient creation; `failFirst` makes the first creation fail after the server "created" nothing. */
    function withCreate(roles: Role[], failFirst = false) {
      const posts: { requestId: string; label: string }[] = [];
      const base = api(roles);
      const impl = vi.fn<typeof fetch>(async (input, init) => {
        if (String(input).includes('/api/v1/patients') && init?.method === 'POST') {
          posts.push(JSON.parse(String(init.body)));
          if (failFirst && posts.length === 1) return new Response('{}', { status: 503 });
          return new Response(JSON.stringify(NEW), { status: 201, headers: { 'Content-Type': 'application/json' } });
        }
        return base(input, init);
      });
      return { impl, posts };
    }
    const addPatient = async (label: string) => {
      const patients = within(await screen.findByRole('region', { name: 'Patients' }));
      await userEvent.click(patients.getByRole('button', { name: 'Add patient' }));
      await userEvent.type(patients.getByRole('textbox', { name: 'Synthetic patient label' }), label);
      await userEvent.click(patients.getByRole('button', { name: 'Create patient' }));
      return patients;
    };

    it('is offered to writer roles only', async () => {
      open('/settings', ['reader']);
      await primary();
      expect(screen.queryByRole('button', { name: 'Add patient' })).toBeNull();
      expect(await panelItems()).toContain('Patients');
    });

    it('creates exactly one patient with a request id, then lists it', async () => {
      const { impl, posts } = withCreate(['clinician']);
      renderApp('/settings', { signedInAs: ['clinician'], fetchImpl: impl as unknown as typeof fetch });
      await primary();
      const patients = await addPatient('SYN-777');
      expect(await within(patients.getByRole('list', { name: 'Patients' })).findByText('SYN-777')).toBeVisible();
      expect(posts).toHaveLength(1);
      expect(posts[0]).toMatchObject({ label: 'SYN-777' });
      expect(posts[0]!.requestId).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('refuses an invalid label before any request', async () => {
      const { impl, posts } = withCreate(['clinician']);
      renderApp('/settings', { signedInAs: ['clinician'], fetchImpl: impl as unknown as typeof fetch });
      await primary();
      const patients = await addPatient('Jane Doe');
      expect(await patients.findByRole('alert')).toHaveTextContent(/letters, numbers and hyphens/i);
      expect(posts).toHaveLength(0);
    });

    it('a retry with the same label reuses the request id, so a lost response never makes a second patient', async () => {
      const { impl, posts } = withCreate(['clinician'], true);
      renderApp('/settings', { signedInAs: ['clinician'], fetchImpl: impl as unknown as typeof fetch });
      await primary();
      const patients = await addPatient('SYN-777');
      expect(await patients.findByRole('alert')).toBeVisible();
      await userEvent.click(patients.getByRole('button', { name: 'Create patient' }));
      expect(await within(patients.getByRole('list', { name: 'Patients' })).findByText('SYN-777')).toBeVisible();
      expect(posts).toHaveLength(2);
      expect(posts[1]!.requestId).toBe(posts[0]!.requestId);
    });
  });

  it('on a phone the menu button opens it, and Escape closes it and returns focus to the button', async () => {
    open('/settings', ['clinician']);
    await primary();
    const toggle = screen.getByRole('button', { name: 'Workspace navigation' });
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    screen.getByRole('link', { name: 'Upload report' }).focus();
    fireEvent.keyDown(screen.getByRole('link', { name: 'Upload report' }), { key: 'Escape' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveFocus();
  });
});
