import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PatientDto } from '@telesphoros/shared-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { preferenceStorage } from '@/lib/storageConsent';
import { RECOVERY_SCOPE, renderApp } from '@/test/authTestUtils';

// Spec 040 slice C: WorkspaceConversation mounts PatientSearchField above PatientPicker (PS-11, PS-12).
// Synthetic data only; `fetch` is replaced at the boundary so the real client, hook, field and picker run.

const FAILED = 'The whole list could not be searched. Showing the loaded patients only.';

const patient = (n: number): PatientDto => ({
  id: `0f8fad5b-d9cb-469f-a165-${String(n).padStart(12, '0')}`,
  label: `SYN-${n}`,
  createdAt: '2026-10-28T12:00:00.000Z',
  updatedAt: '2026-10-28T12:00:00.000Z',
  mergedInto: null,
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const pageOf = (data: PatientDto[], page: number, total: number) => ({ data, meta: { page, pageSize: 20, total, totalPages: Math.ceil(total / 20) } });

function api(search: (url: URL) => Response | Promise<Response>) {
  return vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/me/recovery-scope')) return json({ recoveryScope: RECOVERY_SCOPE });
    if (url.pathname === '/api/v1/me') return json({ roles: ['clinician'] });
    if (url.pathname === '/api/v1/patients' && url.searchParams.has('labelContains')) return search(url);
    if (url.pathname === '/api/v1/patients') {
      const loaded = Array.from({ length: 20 }, (_, index) => patient(20 - index));
      return json(pageOf(loaded, 1, 45));
    }
    if (url.pathname === '/api/v1/reports') return json(pageOf([], 1, 0));
    return json({}, 404);
  });
}

const searches = (fetchImpl: ReturnType<typeof api>) => fetchImpl.mock.calls.map(([input]) => String(input)).filter((url) => url.includes('labelContains'));

async function openUploadDrawer(fetchImpl: ReturnType<typeof api>) {
  renderApp('/chat', { signedInAs: ['clinician'], fetchImpl });
  await screen.findByRole('button', { name: 'Attach a report' });
  const file = new File(['{"synthetic":true}'], 'synthetic.json', { type: 'application/json' });
  await userEvent.upload(document.querySelector<HTMLInputElement>('input[type=file]')!, file);
  const dialog = within(await screen.findByRole('dialog', { name: 'Report details' }));
  await dialog.findByRole('option', { name: 'SYN-20' });
  return {
    dialog,
    field: dialog.getByRole('textbox', { name: 'Find a patient' }),
    picker: dialog.getByRole('combobox', { name: 'Patient' }),
  };
}

afterEach(() => {
  window.localStorage.clear();
  preferenceStorage.choose(true);
  vi.restoreAllMocks();
});

describe('WorkspaceConversation patient search (spec 040 slice C, PS-11, PS-12)', () => {
  it('searches all patients beyond loaded pages, shows matches in the picker, and clears back to loaded pages', async () => {
    const fetchImpl = api(() => json(pageOf([patient(42)], 1, 1)));
    const { dialog, field, picker } = await openUploadDrawer(fetchImpl);
    expect(dialog.queryByRole('option', { name: 'SYN-42' })).not.toBeInTheDocument();

    await userEvent.type(field, 'SYN-42');
    expect(searches(fetchImpl)).toEqual([]);
    await userEvent.click(dialog.getByRole('button', { name: 'Search all patients' }));

    expect(await dialog.findByRole('option', { name: 'SYN-42' })).toBeInTheDocument();
    expect(dialog.queryByRole('option', { name: 'SYN-20' })).not.toBeInTheDocument();
    expect(dialog.getByText('Searched all patients: 1 match.')).toBeVisible();
    expect(dialog.queryByRole('button', { name: 'More patients' })).not.toBeInTheDocument();
    expect(searches(fetchImpl)).toEqual(['http://api.test/api/v1/patients?page=1&pageSize=20&order=desc&labelContains=SYN-42']);

    await userEvent.click(dialog.getByRole('button', { name: 'Clear patient search' }));
    expect(await dialog.findByRole('option', { name: 'SYN-20' })).toBeInTheDocument();
    expect(dialog.queryByRole('option', { name: 'SYN-42' })).not.toBeInTheDocument();
    expect(picker).toHaveValue('');
  });

  it('keeps an already-selected patient selectable when a search does not match it, and keeps a search-selected patient after clearing', async () => {
    const fetchImpl = api((url) => {
      if (url.searchParams.get('labelContains') === 'SYN-99') return json(pageOf([], 1, 0));
      return json(pageOf([patient(42)], 1, 1));
    });
    const { dialog, field, picker } = await openUploadDrawer(fetchImpl);

    // Choose SYN-20 from page 1, then search for SYN-99 (0 matches): SYN-20 stays selected and an option.
    await userEvent.selectOptions(picker, patient(20).id);
    expect(picker).toHaveValue(patient(20).id);
    await userEvent.type(field, 'SYN-99{Enter}');
    expect(await dialog.findByText('Searched all patients: no match.')).toBeVisible();
    // Enter searched without submitting the outer PromptInput form.
    expect(dialog.queryByText('Confirm the file is synthetic.')).not.toBeInTheDocument();
    expect(picker).toHaveValue(patient(20).id);
    expect(dialog.getByRole('option', { name: 'SYN-20' })).toBeInTheDocument();
    expect(dialog.getByText('This report will be saved in the record for SYN-20.')).toBeVisible();

    // Now search SYN-42 (not on page 1), select it, then clear search: SYN-42 stays selected and an option.
    await userEvent.clear(field);
    await userEvent.type(field, 'SYN-42{Enter}');
    await dialog.findByRole('option', { name: 'SYN-42' });
    await userEvent.selectOptions(picker, patient(42).id);
    expect(picker).toHaveValue(patient(42).id);
    expect(dialog.getByText('This report will be saved in the record for SYN-42.')).toBeVisible();

    await userEvent.click(dialog.getByRole('button', { name: 'Clear patient search' }));
    await dialog.findByRole('option', { name: 'SYN-20' });
    expect(picker).toHaveValue(patient(42).id);
    expect(dialog.getByRole('option', { name: 'SYN-42' })).toBeInTheDocument();
    expect(dialog.getByText('This report will be saved in the record for SYN-42.')).toBeVisible();
  });

  it('loads More matches into the picker', async () => {
    const fetchImpl = api((url) => {
      const second = url.searchParams.get('page') === '2';
      return json(pageOf(second ? [patient(1)] : Array.from({ length: 20 }, (_, index) => patient(100 + index)), second ? 2 : 1, 21));
    });
    const { dialog, field } = await openUploadDrawer(fetchImpl);
    await userEvent.type(field, '1{Enter}');
    expect(await dialog.findByRole('option', { name: 'SYN-119' })).toBeInTheDocument();
    expect(dialog.getByText('Searched all patients: 21 matches.')).toBeVisible();
    await userEvent.click(dialog.getByRole('button', { name: 'More matches' }));
    expect(await dialog.findByRole('option', { name: 'SYN-1' })).toBeInTheDocument();
    expect(dialog.queryByRole('button', { name: 'More matches' })).not.toBeInTheDocument();
  });

  const failures: [string, () => Response | Promise<Response>][] = [
    ['400 from an older API', () => json({ error: { code: 'VALIDATION_ERROR' } }, 400)],
    ['403', () => json({}, 403)],
    ['429', () => json({}, 429)],
    ['500', () => json({}, 500)],
    ['a network failure', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['a malformed body', () => json({ data: [{ label: 'SYN-42' }], meta: { page: 1, pageSize: 20, total: 1, totalPages: 1 } })],
  ];
  for (const [name, answer] of failures) {
    it(`on ${name}, keeps loaded choices and shows Retry`, async () => {
      const fetchImpl = api(answer);
      const { dialog, field } = await openUploadDrawer(fetchImpl);
      await userEvent.type(field, 'SYN-42');
      await userEvent.click(dialog.getByRole('button', { name: 'Search all patients' }));
      expect(await dialog.findByRole('alert')).toHaveTextContent(FAILED);
      expect(dialog.getByRole('option', { name: 'SYN-20' })).toBeInTheDocument();
      expect(dialog.queryByText(/Searched all patients/)).not.toBeInTheDocument();
      await userEvent.click(dialog.getByRole('button', { name: 'Retry searching all patients' }));
      await vi.waitFor(() => expect(searches(fetchImpl)).toHaveLength(2));
    });
  }

  it('refuses invalid search text locally with 0 requests', async () => {
    const fetchImpl = api(() => json(pageOf([], 1, 0)));
    const { dialog, field } = await openUploadDrawer(fetchImpl);
    await userEvent.type(field, 'SYN%');
    await userEvent.click(dialog.getByRole('button', { name: 'Search all patients' }));
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveAccessibleDescription(expect.stringContaining('Use letters, numbers and hyphens only.'));
    expect(searches(fetchImpl)).toEqual([]);
  });

  it('aborts an earlier search and drops its late answer (PS-12)', async () => {
    let answerFirst: (response: Response) => void = () => undefined;
    const fetchImpl = api((url) =>
      url.searchParams.get('labelContains') === 'SYN-4'
        ? new Promise<Response>((resolve) => {
            answerFirst = resolve;
          })
        : json(pageOf([patient(41)], 1, 1)),
    );
    const { dialog, field } = await openUploadDrawer(fetchImpl);
    await userEvent.type(field, 'SYN-4{Enter}');
    await vi.waitFor(() => expect(searches(fetchImpl)).toHaveLength(1));
    await userEvent.type(field, '1{Enter}');
    expect(await dialog.findByRole('option', { name: 'SYN-41' })).toBeInTheDocument();
    const first = fetchImpl.mock.calls.find(([input]) => String(input).endsWith('labelContains=SYN-4'))!;
    expect(first[1]?.signal?.aborted).toBe(true);

    answerFirst(json(pageOf([patient(4), patient(40)], 1, 2)));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(dialog.getByText('Searched all patients: 1 match.')).toBeVisible();
    expect(dialog.queryByRole('option', { name: 'SYN-40' })).not.toBeInTheDocument();
  });

  it('resets search state when the attachment is removed, restoring loaded choices on the next attachment while keeping selectedPatient', async () => {
    const fetchImpl = api(() => json(pageOf([patient(42)], 1, 1)));
    const { dialog, field, picker } = await openUploadDrawer(fetchImpl);

    await userEvent.type(field, 'SYN-42{Enter}');
    await dialog.findByRole('option', { name: 'SYN-42' });
    await userEvent.selectOptions(picker, patient(42).id);
    expect(dialog.getByText('Searched all patients: 1 match.')).toBeVisible();

    await userEvent.click(dialog.getByRole('button', { name: 'Remove file' }));
    const nextFile = new File(['{"synthetic":true}'], 'synthetic-2.json', { type: 'application/json' });
    await userEvent.upload(document.querySelector<HTMLInputElement>('input[type=file]')!, nextFile);

    const nextDialog = within(await screen.findByRole('dialog', { name: 'Report details' }));
    expect(nextDialog.getByRole('textbox', { name: 'Find a patient' })).toHaveValue('');
    expect(nextDialog.queryByText(/Searched all patients/)).not.toBeInTheDocument();
    expect(nextDialog.getByRole('option', { name: 'SYN-20' })).toBeInTheDocument();
    expect(nextDialog.getByRole('button', { name: 'More patients' })).toBeVisible();
    expect(nextDialog.getByRole('combobox', { name: 'Patient' })).toHaveValue(patient(42).id);
    expect(nextDialog.getByRole('option', { name: 'SYN-42' })).toBeInTheDocument();
    expect(nextDialog.getByText('This report will be saved in the record for SYN-42.')).toBeVisible();
  });
});
