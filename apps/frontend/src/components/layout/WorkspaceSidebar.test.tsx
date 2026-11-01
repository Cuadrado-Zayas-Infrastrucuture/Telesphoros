import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Role } from '@telesphoros/shared-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RECOVERY_SCOPE, renderApp } from '@/test/authTestUtils';
import { announcePatientAdded } from '@/lib/workspaceEvents';

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
    // Spec 025 T303: each label now opens the patient's page (labels only: no name or date of birth in the panel).
    expect(within(patients).getByRole('link', { name: 'SYN-004' })).toHaveAttribute('href', expect.stringMatching(/^\/patients\/[0-9a-f-]{36}$/));
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

    describe('with demographics (spec 025 T301, T302)', () => {
      const NAME = 'Zzyzx-Needle';
      /** Creation plus `POST /patients/:id/demographics`; `failDemographicsOnce` refuses the first demographics request with 503. */
      function withDemographics(failDemographicsOnce = false) {
        const calls: { path: string; body: Record<string, unknown> }[] = [];
        const { impl: base } = withCreate(['clinician']);
        let demographicsTries = 0;
        const impl = vi.fn<typeof fetch>(async (input, init) => {
          const url = String(input);
          if (init?.method === 'POST') calls.push({ path: new URL(url, 'http://x').pathname, body: JSON.parse(String(init.body)) });
          if (url.includes('/demographics') && init?.method === 'POST') {
            demographicsTries += 1;
            if (failDemographicsOnce && demographicsTries === 1) return new Response('{}', { status: 503 });
            const sent = JSON.parse(String(init.body)) as Record<string, unknown>;
            const at = '2026-10-31T12:00:00.000Z';
            const version = { version: 1, createdAt: at, createdBy: 'person-1', sex: sent.sex ?? null, birthYear: 1980, ethnicity: sent.ethnicity ?? null };
            const dto = {
              patientId: NEW.id,
              current: true,
              givenName: sent.givenName,
              familyName: sent.familyName,
              dateOfBirth: sent.dateOfBirth,
              ageYears: 46,
              ...version,
              versions: [version],
            };
            return new Response(JSON.stringify(dto), { status: 201, headers: { 'Content-Type': 'application/json' } });
          }
          return base(input, init);
        });
        return { impl, calls };
      }
      async function fill(patients: ReturnType<typeof within>, opts: { sexAndEthnicity: boolean }) {
        await userEvent.click(patients.getByRole('button', { name: 'Add patient' }));
        await userEvent.type(patients.getByRole('textbox', { name: 'Synthetic patient label' }), 'SYN-777');
        await userEvent.type(patients.getByRole('textbox', { name: 'Given name' }), NAME);
        await userEvent.type(patients.getByRole('textbox', { name: 'Family name' }), 'Testcase');
        fireEvent.change(patients.getByLabelText('Date of birth'), { target: { value: '1980-02-29' } });
        if (opts.sexAndEthnicity) {
          await userEvent.selectOptions(patients.getByRole('combobox', { name: 'Sex' }), 'female');
          await userEvent.click(patients.getByRole('checkbox', { name: 'Hispanic or Latino' }));
        }
      }

      it('creates the patient, then records its first version with its own request id, and the row is not Incomplete', async () => {
        const { impl, calls } = withDemographics();
        renderApp('/settings', { signedInAs: ['clinician'], fetchImpl: impl as unknown as typeof fetch });
        await primary();
        const patients = within(await screen.findByRole('region', { name: 'Patients' }));
        await fill(patients, { sexAndEthnicity: true });
        await userEvent.click(patients.getByRole('button', { name: 'Create patient' }));
        expect(await patients.findByText('Added SYN-777.')).toBeVisible();
        expect(calls.map((call) => call.path)).toEqual(['/api/v1/patients', `/api/v1/patients/${NEW.id}/demographics`]);
        expect(calls[1]!.body).toMatchObject({ givenName: NAME, familyName: 'Testcase', dateOfBirth: '1980-02-29', sex: 'female', ethnicity: ['hispanic-or-latino'] });
        expect(calls[1]!.body.requestId).toMatch(/^[0-9a-f-]{36}$/);
        expect(calls[1]!.body.requestId).not.toBe(calls[0]!.body.requestId);
        const row = within(patients.getByRole('list', { name: 'Patients' }))
          .getByRole('link', { name: 'SYN-777' })
          .closest('li')!;
        expect(within(row).queryByText('Incomplete')).toBeNull();
        // The draft is dropped once saved: reopening the form shows empty fields.
        await userEvent.click(patients.getByRole('button', { name: 'Add patient' }));
        expect(patients.getByRole('textbox', { name: 'Given name' })).toHaveValue('');
      });

      it('a label alone adds the patient and marks it Incomplete, without a demographics request', async () => {
        const { impl, calls } = withDemographics();
        renderApp('/settings', { signedInAs: ['clinician'], fetchImpl: impl as unknown as typeof fetch });
        await primary();
        const patients = await addPatient('SYN-777');
        expect(await patients.findByText('Added SYN-777.')).toBeVisible();
        expect(calls.map((call) => call.path)).toEqual(['/api/v1/patients']);
        const row = within(patients.getByRole('list', { name: 'Patients' }))
          .getByRole('link', { name: 'SYN-777' })
          .closest('li')!;
        expect(within(row).getByText('Incomplete')).toHaveClass('text-warning');
      });

      it('names and a date without sex and ethnicity are saved, and the row stays Incomplete', async () => {
        const { impl, calls } = withDemographics();
        renderApp('/settings', { signedInAs: ['clinician'], fetchImpl: impl as unknown as typeof fetch });
        await primary();
        const patients = within(await screen.findByRole('region', { name: 'Patients' }));
        await fill(patients, { sexAndEthnicity: false });
        await userEvent.click(patients.getByRole('button', { name: 'Create patient' }));
        expect(await patients.findByText('Added SYN-777.')).toBeVisible();
        expect(calls[1]!.body).toMatchObject({ sex: null, ethnicity: null });
        const row = within(patients.getByRole('list', { name: 'Patients' }))
          .getByRole('link', { name: 'SYN-777' })
          .closest('li')!;
        expect(within(row).getByText('Incomplete')).toBeVisible();
      });

      it('when the demographics fail, the patient stays, and the retry sends only the demographics with the same request id', async () => {
        const { impl, calls } = withDemographics(true);
        renderApp('/settings', { signedInAs: ['clinician'], fetchImpl: impl as unknown as typeof fetch });
        await primary();
        const patients = within(await screen.findByRole('region', { name: 'Patients' }));
        await fill(patients, { sexAndEthnicity: true });
        await userEvent.click(patients.getByRole('button', { name: 'Create patient' }));
        const alert = await patients.findByRole('alert');
        expect(alert).toHaveTextContent('SYN-777 was added, but its demographics were not saved.');
        expect(alert.textContent).not.toContain(NAME);
        expect(within(patients.getByRole('list', { name: 'Patients' })).getByRole('link', { name: 'SYN-777' })).toBeVisible();
        await userEvent.click(patients.getByRole('button', { name: 'Save demographics' }));
        expect(await patients.findByText('Added SYN-777.')).toBeVisible();
        const paths = calls.map((call) => call.path);
        expect(paths.filter((path) => path === '/api/v1/patients')).toHaveLength(1);
        expect(paths.filter((path) => path.endsWith('/demographics'))).toHaveLength(2);
        expect(calls[2]!.body.requestId).toBe(calls[1]!.body.requestId);
      });

      it('refuses sex without a name and date of birth before any request, naming the fields only', async () => {
        const { impl, calls } = withDemographics();
        renderApp('/settings', { signedInAs: ['clinician'], fetchImpl: impl as unknown as typeof fetch });
        await primary();
        const patients = within(await screen.findByRole('region', { name: 'Patients' }));
        await userEvent.click(patients.getByRole('button', { name: 'Add patient' }));
        await userEvent.type(patients.getByRole('textbox', { name: 'Synthetic patient label' }), 'SYN-777');
        await userEvent.selectOptions(patients.getByRole('combobox', { name: 'Sex' }), 'male');
        await userEvent.click(patients.getByRole('button', { name: 'Create patient' }));
        expect(await patients.findByText('Enter the given name.')).toBeVisible();
        expect(patients.getByText('Enter the date of birth.')).toBeVisible();
        expect(calls).toHaveLength(0);
      });
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

describe('the demographics line under Patients (spec 025 T304)', () => {
  const COUNTS_PATH = '/api/v1/patients/demographics-completeness';
  /** The panel's usual answers, plus the counts route: a body, or `unavailable` for the in-memory store's 503. */
  function withCounts(answer: () => object | 'unavailable') {
    const base = api(['clinician']);
    const impl = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).endsWith(COUNTS_PATH)) {
        const body = answer();
        return body === 'unavailable' ? new Response('{}', { status: 503 }) : new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
      }
      return base(input, init);
    });
    return impl;
  }
  const patientsSection = async () => {
    await panelItems();
    return within(screen.getByRole('region', { name: 'Patients' }));
  };

  it('says how many have complete demographics, in color: warning while some are missing, success when all are there', async () => {
    renderApp('/settings', { signedInAs: ['clinician'], fetchImpl: withCounts(() => ({ patients: 20, complete: 12, incomplete: 5, none: 3 })) as unknown as typeof fetch });
    expect(await (await patientsSection()).findByText('12 of 20 complete')).toHaveClass('text-warning');
  });

  it('shows success when every patient is complete', async () => {
    renderApp('/settings', { signedInAs: ['clinician'], fetchImpl: withCounts(() => ({ patients: 2, complete: 2, incomplete: 0, none: 0 })) as unknown as typeof fetch });
    expect(await (await patientsSection()).findByText('2 of 2 complete')).toHaveClass('text-success');
  });

  it('leaves the line out, with no alert, when the counts cannot be read, when there are no patients, or when the answer is malformed', async () => {
    for (const answer of ['unavailable', { patients: 0, complete: 0, incomplete: 0, none: 0 }, { patients: 5, complete: 1, incomplete: 1, none: 1 }] as const) {
      const { unmount } = renderApp('/settings', { signedInAs: ['clinician'], fetchImpl: withCounts(() => answer) as unknown as typeof fetch });
      const section = await patientsSection();
      await vi.waitFor(() => expect(section.getByRole('list', { name: 'Patients' })).toBeVisible());
      expect(section.queryByText(/Demographics:/)).toBeNull();
      expect(section.queryByRole('alert')).toBeNull();
      unmount();
    }
  });

  it('reads the counts again when a patient is added elsewhere (the chat), so the line moves', async () => {
    let answer = { patients: 1, complete: 1, incomplete: 0, none: 0 };
    const impl = withCounts(() => answer);
    renderApp('/settings', { signedInAs: ['clinician'], fetchImpl: impl as unknown as typeof fetch });
    expect(await (await patientsSection()).findByText('1 of 1 complete')).toBeVisible();
    answer = { patients: 2, complete: 1, incomplete: 0, none: 1 };
    announcePatientAdded({
      id: '3b241101-e2bb-4255-8caf-4136c566a962',
      label: 'SYN-NEW',
      createdAt: '2026-10-31T12:00:00.000Z',
      updatedAt: '2026-10-31T12:00:00.000Z',
      mergedInto: null,
      demographicsComplete: false,
    });
    expect(await (await patientsSection()).findByText('1 of 2 complete')).toHaveClass('text-warning');
    expect(impl.mock.calls.filter(([input]) => String(input).endsWith(COUNTS_PATH))).toHaveLength(2);
  });
});
