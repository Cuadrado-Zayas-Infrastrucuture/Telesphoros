import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PatientDto } from '@telesphoros/shared-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { preferenceStorage } from '@/lib/storageConsent';
import { RECOVERY_SCOPE, renderApp } from '@/test/authTestUtils';

// Spec 040 slice B: the roster searches the whole patient list only when asked, and says so only on a 200 (PS-10, PS-12, D4). Hand-written
// expectations from the specification; `fetch` is replaced at the boundary, so the real client, hook and page run. Synthetic labels only.

const FAILED = 'The whole list could not be searched. Showing the loaded patients only.';
const LOADED_SCOPE = 'Typing looks through the 20 patients loaded so far. Search all patients looks through every one.';

const patient = (n: number): PatientDto => ({
  id: `0f8fad5b-d9cb-469f-a165-${String(n).padStart(12, '0')}`,
  label: `SYN-${n}`,
  createdAt: '2026-10-28T12:00:00.000Z',
  updatedAt: '2026-10-28T12:00:00.000Z',
  mergedInto: null,
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const pageOf = (data: PatientDto[], page: number, total: number) => ({ data, meta: { page, pageSize: 20, total, totalPages: Math.ceil(total / 20) } });

/** The loaded list holds SYN-1 to SYN-20 on page 1 of 2 (or every patient, when `allLoaded`); `search` answers each search request. */
function api(search: (url: URL) => Response | Promise<Response>, allLoaded = false) {
  return vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/me/recovery-scope')) return json({ recoveryScope: RECOVERY_SCOPE });
    if (url.pathname === '/api/v1/me') return json({ roles: ['clinician'] });
    if (url.pathname === '/api/v1/patients' && url.searchParams.has('labelContains')) return search(url);
    if (url.pathname === '/api/v1/patients') {
      const loaded = Array.from({ length: 20 }, (_, index) => patient(20 - index));
      return json(pageOf(loaded, 1, allLoaded ? 20 : 45));
    }
    return json({}, 404);
  });
}
const searches = (fetchImpl: ReturnType<typeof api>) => fetchImpl.mock.calls.map(([input]) => String(input)).filter((url) => url.includes('labelContains'));

async function openRoster(fetchImpl: ReturnType<typeof api>) {
  renderApp('/patients', { signedInAs: ['clinician'], fetchImpl });
  const roster = within(await screen.findByRole('region', { name: 'Patient records' }));
  await roster.findByRole('link', { name: 'SYN-20' });
  return { roster, field: roster.getByRole('textbox', { name: 'Find a patient' }) };
}

afterEach(() => {
  window.localStorage.clear();
  preferenceStorage.choose(true);
  vi.restoreAllMocks();
});

describe('searching all patients (spec 040 PS-10)', () => {
  it('typing filters the loaded rows at once and sends nothing; Search all patients asks the server, and its 200 shows the matches', async () => {
    const fetchImpl = api(() => json(pageOf([patient(42)], 1, 1)));
    const { roster, field } = await openRoster(fetchImpl);
    await userEvent.type(field, 'SYN-42');
    expect(roster.getByText('No match among loaded patients. Search all patients to keep looking.')).toBeVisible();
    expect(field).toHaveAccessibleDescription(LOADED_SCOPE);
    expect(searches(fetchImpl)).toEqual([]);

    await userEvent.click(roster.getByRole('button', { name: 'Search all patients' }));
    expect(await roster.findByRole('link', { name: 'SYN-42' })).toHaveAttribute('href', `/patients/${patient(42).id}`);
    expect(field).toHaveAccessibleDescription('Searched all patients: 1 match.');
    expect(roster.queryByRole('link', { name: 'SYN-20' })).not.toBeInTheDocument();
    expect(roster.queryByText(/No match among loaded patients/)).not.toBeInTheDocument();
    expect(roster.queryByRole('button', { name: 'More patients' })).not.toBeInTheDocument();
    expect(searches(fetchImpl)).toEqual(['http://api.test/api/v1/patients?page=1&pageSize=20&order=desc&labelContains=SYN-42']);
  });

  it('Enter searches too; the text is trimmed; changing it returns to the loaded rows and their sentence', async () => {
    const fetchImpl = api(() => json(pageOf([patient(30), patient(3)], 1, 2)));
    const { roster, field } = await openRoster(fetchImpl);
    await userEvent.type(field, ' SYN-3 {Enter}');
    expect(await roster.findByRole('link', { name: 'SYN-30' })).toBeVisible();
    expect(field).toHaveAccessibleDescription('Searched all patients: 2 matches.');
    expect(searches(fetchImpl)).toEqual(['http://api.test/api/v1/patients?page=1&pageSize=20&order=desc&labelContains=SYN-3']);
    await userEvent.clear(field);
    expect(await roster.findByRole('link', { name: 'SYN-20' })).toBeVisible();
    expect(roster.queryByRole('link', { name: 'SYN-30' })).not.toBeInTheDocument();
    expect(field).toHaveAccessibleDescription(LOADED_SCOPE);
  });

  it('says so when nothing matches anywhere', async () => {
    const { roster, field } = await openRoster(api(() => json(pageOf([], 1, 0))));
    await userEvent.type(field, 'SYN-99{Enter}');
    await vi.waitFor(() => expect(field).toHaveAccessibleDescription('Searched all patients: no match.'));
    expect(roster.queryByRole('link', { name: /^SYN-/ })).not.toBeInTheDocument();
  });

  it('More matches loads the next page of the same search', async () => {
    const fetchImpl = api((url) => {
      const second = url.searchParams.get('page') === '2';
      return json(pageOf(second ? [patient(1)] : Array.from({ length: 20 }, (_, index) => patient(100 + index)), second ? 2 : 1, 21));
    });
    const { roster, field } = await openRoster(fetchImpl);
    await userEvent.type(field, '1{Enter}');
    expect(await roster.findByRole('link', { name: 'SYN-119' })).toBeVisible();
    expect(field).toHaveAccessibleDescription('Searched all patients: 21 matches.');
    await userEvent.click(roster.getByRole('button', { name: 'More matches' }));
    expect(await roster.findByRole('link', { name: 'SYN-1' })).toBeVisible();
    expect(roster.queryByRole('button', { name: 'More matches' })).not.toBeInTheDocument();
    expect(searches(fetchImpl).at(-1)).toBe('http://api.test/api/v1/patients?page=2&pageSize=20&order=desc&labelContains=1');
  });

  // 401 is not here: it ends the session and starts a new sign-in (AuthProvider), so no list stays on screen to fall back to.
  const failures: [string, () => Response | Promise<Response>][] = [
    ['400 from an older API', () => json({ error: { code: 'VALIDATION_ERROR' } }, 400)],
    ['403', () => json({}, 403)],
    ['429', () => json({}, 429)],
    ['500', () => json({}, 500)],
    ['a network failure', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['a body that fails the shared schema', () => json({ data: [{ label: 'SYN-42' }], meta: { page: 1, pageSize: 20, total: 1, totalPages: 1 } })],
    ['a page of the wrong size', () => json({ data: [], meta: { page: 1, pageSize: 50, total: 0, totalPages: 0 } })],
  ];
  for (const [name, answer] of failures) {
    it(`on ${name}, keeps the loaded rows, their filter and their sentence, and says the whole list was not searched, with Retry`, async () => {
      const fetchImpl = api(answer);
      const { roster, field } = await openRoster(fetchImpl);
      await userEvent.type(field, 'SYN-2');
      await userEvent.click(roster.getByRole('button', { name: 'Search all patients' }));
      expect(await roster.findByRole('alert')).toHaveTextContent(FAILED);
      expect(field).toHaveAccessibleDescription(LOADED_SCOPE);
      expect(roster.getByRole('link', { name: 'SYN-20' })).toBeVisible();
      expect(roster.getByRole('link', { name: 'SYN-2' })).toBeVisible();
      expect(roster.queryByRole('link', { name: 'SYN-19' })).not.toBeInTheDocument();
      expect(roster.queryByText(/Searched all patients/)).not.toBeInTheDocument();
      await userEvent.click(roster.getByRole('button', { name: 'Retry searching all patients' }));
      await vi.waitFor(() => expect(searches(fetchImpl)).toHaveLength(2));
    });
  }

  it('never sends a text the label alphabet refuses, and says which characters it takes', async () => {
    const fetchImpl = api(() => json(pageOf([], 1, 0)));
    const { roster, field } = await openRoster(fetchImpl);
    for (const text of ['SYN%', 'SYN_1', "S'1", 'SYN 1', 'A'.repeat(41)]) {
      await userEvent.clear(field);
      await userEvent.type(field, text);
      await userEvent.click(roster.getByRole('button', { name: 'Search all patients' }));
      expect(field, text).toHaveAccessibleDescription(expect.stringContaining(text.length > 40 ? 'Use 40 characters or fewer.' : 'Use letters, numbers and hyphens only.'));
      expect(field).toHaveAttribute('aria-invalid', 'true');
    }
    await userEvent.clear(field);
    await userEvent.click(roster.getByRole('button', { name: 'Search all patients' }));
    expect(field).toHaveAccessibleDescription(expect.stringContaining('Enter part of a patient label.'));
    expect(searches(fetchImpl)).toEqual([]);
  });

  it('offers no server search when every page is loaded: the loaded filter already covers everyone', async () => {
    const fetchImpl = api(() => json(pageOf([], 1, 0)), true);
    const { roster, field } = await openRoster(fetchImpl);
    expect(field).toHaveAccessibleDescription('Typing looks through all 20 patients.');
    expect(roster.queryByRole('button', { name: 'Search all patients' })).not.toBeInTheDocument();
    await userEvent.type(field, 'SYN-7{Enter}');
    expect(roster.getByRole('link', { name: 'SYN-7' })).toBeVisible();
    expect(searches(fetchImpl)).toEqual([]);
  });
});

describe('a newer search always wins (spec 040 PS-12)', () => {
  it('aborts the earlier request and drops its late answer', async () => {
    let answerFirst: (response: Response) => void = () => undefined;
    const fetchImpl = api((url) =>
      url.searchParams.get('labelContains') === 'SYN-4'
        ? new Promise<Response>((resolve) => {
            answerFirst = resolve;
          })
        : json(pageOf([patient(41)], 1, 1)),
    );
    const { roster, field } = await openRoster(fetchImpl);
    await userEvent.type(field, 'SYN-4{Enter}');
    await vi.waitFor(() => expect(searches(fetchImpl)).toHaveLength(1));
    await userEvent.type(field, '1{Enter}');
    expect(await roster.findByRole('link', { name: 'SYN-41' })).toBeVisible();
    const first = fetchImpl.mock.calls.find(([input]) => String(input).endsWith('labelContains=SYN-4'))!;
    expect(first[1]?.signal?.aborted).toBe(true);

    answerFirst(json(pageOf([patient(4), patient(40)], 1, 2)));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(field).toHaveAccessibleDescription('Searched all patients: 1 match.');
    expect(roster.queryByRole('link', { name: 'SYN-40' })).not.toBeInTheDocument();
  });
});
