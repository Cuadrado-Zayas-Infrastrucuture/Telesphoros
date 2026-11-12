import { preferenceStorage } from '@/lib/storageConsent';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PatientDto, Role } from '@telesphoros/shared-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RECOVERY_SCOPE, renderApp } from '@/test/authTestUtils';
import { announcePatientAdded, onPatientAdded } from '@/lib/workspaceEvents';

const PATIENT = { id: '0f8fad5b-d9cb-469f-a165-70867728950e', label: 'SYN-004', createdAt: '2026-10-28T12:00:00.000Z', updatedAt: '2026-10-28T12:00:00.000Z', mergedInto: null };
const NEW = { ...PATIENT, id: '1a8fad5b-d9cb-469f-a165-70867728950f', label: 'SYN-777' };
const page = (data: unknown[]) => ({ data, meta: { page: 1, pageSize: 20, total: data.length, totalPages: data.length ? 1 : 0 } });
function api(roles: Role[]) {
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    const body = url.includes('/api/v1/patients')
      ? page([PATIENT])
      : url.includes('/api/v1/reports')
        ? page([])
        : url.endsWith('/api/v1/me/recovery-scope')
          ? { recoveryScope: RECOVERY_SCOPE }
          : { roles };
    return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
  });
}
const open = (path: string, roles: Role[], fetchImpl: ReturnType<typeof vi.fn<typeof fetch>> = api(roles)) =>
  renderApp(path, { signedInAs: roles, fetchImpl: fetchImpl as unknown as typeof fetch });
const roster = async () => within(await screen.findByRole('region', { name: 'Patient records' }));
/** Every patient the chat or a form announces while the test runs, as the lists that are mounted would receive it. */
function announced() {
  const seen: PatientDto[] = [];
  const stop = onPatientAdded((patient) => seen.push(patient));
  return { seen, stop };
}

afterEach(() => {
  window.localStorage.clear();
  preferenceStorage.choose(true);
  vi.restoreAllMocks();
});

describe('the Patients page (specs/034 D2)', () => {
  it('is the sidebar destination for every clinical read role, and absent for an administrator alone', async () => {
    for (const roles of [['clinician'], ['reader'], ['reviewer']] as Role[][]) {
      const { unmount } = open('/settings', roles);
      // Wait for the sidebar: until sign-in finishes, the signed-out header has its own "Primary" navigation.
      await screen.findByRole('button', { name: /^(Collapse|Expand) sidebar$/ });
      const nav = within(screen.getByRole('navigation', { name: 'Primary' }));
      expect(await nav.findByRole('link', { name: 'Patients' }), roles.join('+')).toHaveAttribute('href', '/patients');
      unmount();
    }
    open('/usage', ['admin']);
    await screen.findByRole('button', { name: /^(Collapse|Expand) sidebar$/ });
    expect(within(screen.getByRole('navigation', { name: 'Primary' })).queryByRole('link', { name: 'Patients' })).toBeNull();
  });

  it('lists the first page of labels, newest first, each a link to its page', async () => {
    const fetchImpl = api(['clinician']);
    open('/patients', ['clinician'], fetchImpl);
    expect(await screen.findByRole('heading', { level: 1, name: 'Patients' })).toBeVisible();
    const list = await (await roster()).findByRole('list', { name: 'Patients' });
    expect(await within(list).findByRole('link', { name: 'SYN-004' })).toHaveAttribute('href', `/patients/${PATIENT.id}`);
    expect(fetchImpl.mock.calls.some(([input]) => String(input).endsWith('/api/v1/patients?page=1&pageSize=20&order=desc'))).toBe(true);
  });

  // Specs/038 D17: the filter searches what the page has loaded. No server search exists, so the page says how far the filter reaches.
  it('says the filter covers only the patients loaded so far while more remain, and all of them once every page is loaded', async () => {
    const many = (from: number, count: number) =>
      Array.from({ length: count }, (_, index) => ({ ...PATIENT, id: `0f8fad5b-d9cb-469f-a165-7086772895${String(from + index).padStart(2, '0')}`, label: `SYN-${from + index}` }));
    const base = api(['clinician']);
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname !== '/api/v1/patients' || url.searchParams.has('includeMerged')) return base(input, init);
      const second = url.searchParams.get('page') === '2';
      return new Response(JSON.stringify({ data: second ? many(26, 2) : many(6, 20), meta: { page: second ? 2 : 1, pageSize: 20, total: 22, totalPages: 2 } }));
    });
    open('/patients', ['clinician'], fetchImpl);
    const records = await roster();
    const filter = await records.findByRole('textbox', { name: 'Find loaded patients' });
    expect(filter).toHaveAccessibleDescription('This searches the 20 patients loaded so far, not the whole list. Load more to widen it.');
    await userEvent.type(filter, 'SYN-27');
    expect(records.getByText('No match among loaded patients. Load more to keep looking.')).toBeVisible();
    await userEvent.click(records.getByRole('button', { name: 'More patients' }));
    expect(await records.findByRole('link', { name: 'SYN-27' })).toBeVisible();
    expect(filter).toHaveAccessibleDescription('This searches all 22 patients.');
  });

  it('shows a patient the chat adds while the page is open', async () => {
    open('/patients', ['clinician']);
    await (await roster()).findByRole('link', { name: 'SYN-004' });
    announcePatientAdded({ ...NEW, demographicsComplete: false });
    const row = (await (await roster()).findByRole('link', { name: 'SYN-777' })).closest('li')!;
    expect(within(row).getByText('Incomplete')).toHaveClass('text-warning');
  });

  describe('Add patient (specs/024 CH-9, D2a)', () => {
    /** The page's API plus patient creation; `failFirst` makes the first creation fail after the server "created" nothing. */
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
      await userEvent.click(await screen.findByRole('link', { name: 'Add patient' }));
      await userEvent.type(await screen.findByRole('textbox', { name: 'Synthetic patient label' }), label);
      await userEvent.click(screen.getByRole('button', { name: 'Create patient' }));
    };
    const onPatientPage = () => waitFor(() => expect(screen.queryByRole('button', { name: 'Create patient' })).toBeNull());

    it('is offered to writer roles only', async () => {
      open('/patients', ['reader']);
      await (await roster()).findByRole('link', { name: 'SYN-004' });
      expect(screen.queryByRole('link', { name: 'Add patient' })).toBeNull();
    });

    it('creates exactly one patient with a request id, then announces it as Incomplete', async () => {
      const { impl, posts } = withCreate(['clinician']);
      const { seen, stop } = announced();
      open('/patients', ['clinician'], impl);
      await addPatient('SYN-777');
      await onPatientPage();
      expect(posts).toHaveLength(1);
      expect(posts[0]).toMatchObject({ label: 'SYN-777' });
      expect(posts[0]!.requestId).toMatch(/^[0-9a-f-]{36}$/);
      expect(seen.at(-1)).toMatchObject({ id: NEW.id, demographicsComplete: false });
      stop();
    });

    it('refuses an invalid label before any request', async () => {
      const { impl, posts } = withCreate(['clinician']);
      open('/patients', ['clinician'], impl);
      await addPatient('Jane Doe');
      expect(await screen.findByRole('alert')).toHaveTextContent(/letters, numbers and hyphens/i);
      expect(posts).toHaveLength(0);
    });

    it('a retry with the same label reuses the request id, so a lost response never makes a second patient', async () => {
      const { impl, posts } = withCreate(['clinician'], true);
      open('/patients', ['clinician'], impl);
      await addPatient('SYN-777');
      expect(await screen.findByRole('alert')).toBeVisible();
      await userEvent.click(screen.getByRole('button', { name: 'Create patient' }));
      await onPatientPage();
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
      async function fill(opts: { sexAndEthnicity: boolean }) {
        await userEvent.click(await screen.findByRole('link', { name: 'Add patient' }));
        await userEvent.type(await screen.findByRole('textbox', { name: 'Synthetic patient label' }), 'SYN-777');
        await userEvent.type(screen.getByRole('textbox', { name: 'Given name' }), NAME);
        await userEvent.type(screen.getByRole('textbox', { name: 'Family name' }), 'Testcase');
        fireEvent.change(screen.getByLabelText('Date of birth'), { target: { value: '1980-02-29' } });
        if (opts.sexAndEthnicity) {
          await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Sex' }), 'female');
          await userEvent.click(screen.getByRole('checkbox', { name: 'Hispanic or Latino' }));
        }
      }

      it('creates the patient, then records its first version with its own request id, and announces it complete', async () => {
        const { impl, calls } = withDemographics();
        const { seen, stop } = announced();
        open('/patients', ['clinician'], impl);
        await fill({ sexAndEthnicity: true });
        await userEvent.click(screen.getByRole('button', { name: 'Create patient' }));
        await onPatientPage();
        expect(calls.map((call) => call.path)).toEqual(['/api/v1/patients', `/api/v1/patients/${NEW.id}/demographics`]);
        expect(calls[1]!.body).toMatchObject({ givenName: NAME, familyName: 'Testcase', dateOfBirth: '1980-02-29', sex: 'female', ethnicity: ['hispanic-or-latino'] });
        expect(calls[1]!.body.requestId).toMatch(/^[0-9a-f-]{36}$/);
        expect(calls[1]!.body.requestId).not.toBe(calls[0]!.body.requestId);
        expect(seen.at(-1)).toMatchObject({ id: NEW.id, demographicsComplete: true });
        stop();
        // The draft is dropped once saved: reopening the form shows empty fields.
        await userEvent.click(within(screen.getByRole('navigation', { name: 'Primary' })).getByRole('link', { name: 'Patients' }));
        await userEvent.click(await screen.findByRole('link', { name: 'Add patient' }));
        expect(await screen.findByRole('textbox', { name: 'Given name' })).toHaveValue('');
      });

      it('a label alone adds the patient as Incomplete, without a demographics request', async () => {
        const { impl, calls } = withDemographics();
        const { seen, stop } = announced();
        open('/patients', ['clinician'], impl);
        await addPatient('SYN-777');
        await onPatientPage();
        expect(calls.map((call) => call.path)).toEqual(['/api/v1/patients']);
        expect(seen.at(-1)).toMatchObject({ id: NEW.id, demographicsComplete: false });
        stop();
      });

      it('names and a date without sex and ethnicity are saved, and the patient stays Incomplete', async () => {
        const { impl, calls } = withDemographics();
        const { seen, stop } = announced();
        open('/patients', ['clinician'], impl);
        await fill({ sexAndEthnicity: false });
        await userEvent.click(screen.getByRole('button', { name: 'Create patient' }));
        await onPatientPage();
        expect(calls[1]!.body).toMatchObject({ sex: null, ethnicity: null });
        expect(seen.at(-1)).toMatchObject({ id: NEW.id, demographicsComplete: false });
        stop();
      });

      it('when the demographics fail, the patient stays, and the retry sends only the demographics with the same request id', async () => {
        const { impl, calls } = withDemographics(true);
        open('/patients', ['clinician'], impl);
        await fill({ sexAndEthnicity: true });
        await userEvent.click(screen.getByRole('button', { name: 'Create patient' }));
        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent('SYN-777 was added, but its demographics were not saved.');
        expect(alert.textContent).not.toContain(NAME);
        await userEvent.click(screen.getByRole('button', { name: 'Save demographics' }));
        await onPatientPage();
        const paths = calls.map((call) => call.path);
        expect(paths.filter((path) => path === '/api/v1/patients')).toHaveLength(1);
        expect(paths.filter((path) => path.endsWith('/demographics'))).toHaveLength(2);
        expect(calls[2]!.body.requestId).toBe(calls[1]!.body.requestId);
      });

      it('refuses sex without a name and date of birth before any request, naming the fields only', async () => {
        const { impl, calls } = withDemographics();
        open('/patients', ['clinician'], impl);
        await userEvent.click(await screen.findByRole('link', { name: 'Add patient' }));
        await userEvent.type(await screen.findByRole('textbox', { name: 'Synthetic patient label' }), 'SYN-777');
        await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Sex' }), 'male');
        await userEvent.click(screen.getByRole('button', { name: 'Create patient' }));
        expect(await screen.findByText('Enter the given name.')).toBeVisible();
        expect(screen.getByText('Enter the date of birth.')).toBeVisible();
        expect(calls).toHaveLength(0);
      });
    });
  });
});

describe('the demographics line on the Patients page (spec 025 T304)', () => {
  const COUNTS_PATH = '/api/v1/patients/demographics-completeness';
  /** The page's usual answers, plus the counts route: a body, or `unavailable` for the in-memory store's 503. */
  function withCounts(answer: () => object | 'unavailable') {
    const base = api(['clinician']);
    return vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).endsWith(COUNTS_PATH)) {
        const body = answer();
        return body === 'unavailable' ? new Response('{}', { status: 503 }) : new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
      }
      return base(input, init);
    });
  }

  it('says how many have complete demographics, in color: warning while some are missing, success when all are there', async () => {
    open(
      '/patients',
      ['clinician'],
      withCounts(() => ({ patients: 20, complete: 12, incomplete: 5, none: 3 })),
    );
    expect(await (await roster()).findByText('12 of 20 complete')).toHaveClass('text-warning');
  });

  it('shows success when every patient is complete', async () => {
    open(
      '/patients',
      ['clinician'],
      withCounts(() => ({ patients: 2, complete: 2, incomplete: 0, none: 0 })),
    );
    expect(await (await roster()).findByText('2 of 2 complete')).toHaveClass('text-success');
  });

  it('leaves the line out, with no alert, when the counts cannot be read, when there are no patients, or when the answer is malformed', async () => {
    for (const answer of ['unavailable', { patients: 0, complete: 0, incomplete: 0, none: 0 }, { patients: 5, complete: 1, incomplete: 1, none: 1 }] as const) {
      const { unmount } = open(
        '/patients',
        ['clinician'],
        withCounts(() => answer),
      );
      const section = await roster();
      await vi.waitFor(() => expect(section.getByRole('list', { name: 'Patients' })).toBeVisible());
      expect(section.queryByText(/Demographics:/)).toBeNull();
      expect(section.queryByRole('alert')).toBeNull();
      unmount();
    }
  });

  it('reads the counts again when a patient is added elsewhere (the chat), so the line moves', async () => {
    let answer = { patients: 1, complete: 1, incomplete: 0, none: 0 };
    const impl = withCounts(() => answer);
    open('/patients', ['clinician'], impl);
    expect(await (await roster()).findByText('1 of 1 complete')).toBeVisible();
    answer = { patients: 2, complete: 1, incomplete: 0, none: 1 };
    announcePatientAdded({ ...NEW, id: '3b241101-e2bb-4255-8caf-4136c566a962', label: 'SYN-NEW', demographicsComplete: false });
    expect(await (await roster()).findByText('1 of 2 complete')).toHaveClass('text-warning');
    expect(impl.mock.calls.filter(([input]) => String(input).endsWith(COUNTS_PATH))).toHaveLength(2);
  });
});
