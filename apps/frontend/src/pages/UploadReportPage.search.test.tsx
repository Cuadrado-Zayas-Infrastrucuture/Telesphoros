import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PatientDto } from '@telesphoros/shared-types';
import UploadReportPage from '@/pages/UploadReportPage';
import { submitReport } from '@/lib/api';
import { endRecoverySession, startRecoverySession, type RecoverySession } from '@/lib/uploadRecovery';

// Spec 040 slice C (PS-11, PS-12): Attach a report searches every patient on request. Hand-written expectations from the specification;
// the API is replaced at `apiFetch`, so the real client, hook, field and picker run. Synthetic labels only.

const apiFetch = vi.fn<(path: string, init?: RequestInit) => Promise<Response>>();
let owner: RecoverySession;
vi.mock('@/auth/AuthProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/auth/AuthProvider')>()),
  useAuth: () => ({ apiFetch, recoverySession: owner }),
}));
vi.mock('@/lib/api', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/api')>()), submitReport: vi.fn() }));

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
const LOADED = Array.from({ length: 20 }, (_, index) => patient(index + 1));

/** The loaded list is SYN-1 to SYN-20, page 1 of 3 (or of 1, when `onePage`); `search` answers each search request. */
function answer(search: (url: URL) => Response | Promise<Response>, onePage = false) {
  apiFetch.mockImplementation(async (path) => {
    const url = new URL(path, 'http://synthetic');
    if (url.pathname === '/api/v1/patients' && url.searchParams.has('labelContains')) return search(url);
    if (url.pathname === '/api/v1/patients') return json(pageOf(LOADED, 1, onePage ? 20 : 45));
    return json({}, 404);
  });
}
const searches = () => apiFetch.mock.calls.map(([path]) => path).filter((path) => path.includes('labelContains'));
const picker = () => screen.getByLabelText(/synthetic patient \(required\)/i) as HTMLSelectElement;
const optionLabels = () => [...picker().options].map((option) => option.textContent);

async function open() {
  render(<UploadReportPage />, { wrapper: MemoryRouter });
  await screen.findByRole('option', { name: 'SYN-20' });
  return screen.getByRole('textbox', { name: 'Find a patient' });
}

beforeEach(() => {
  apiFetch.mockReset();
  vi.mocked(submitReport).mockReset();
  window.sessionStorage.clear();
  owner = startRecoverySession('a'.repeat(64));
});
afterEach(() => {
  endRecoverySession(owner);
  window.sessionStorage.clear();
});

describe('searching all patients on Attach a report (spec 040 slice C)', () => {
  it('Search all patients makes the choices the matches, says so, and the match can be chosen', async () => {
    answer(() => json(pageOf([patient(42)], 1, 1)));
    const field = await open();
    await userEvent.type(field, 'SYN-42');
    expect(searches()).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: 'Search all patients' }));
    await screen.findByRole('option', { name: 'SYN-42' });
    expect(field).toHaveAccessibleDescription('Searched all patients: 1 match. The choices below are the matches.');
    expect(optionLabels()).toEqual(['Choose an existing patient…', 'SYN-42']);
    expect(screen.queryByRole('button', { name: 'Next patients' })).not.toBeInTheDocument();
    expect(searches()).toEqual(['/api/v1/patients?page=1&pageSize=20&order=desc&labelContains=SYN-42']);
    await userEvent.selectOptions(picker(), patient(42).id);
    expect(picker()).toHaveValue(patient(42).id);
  });

  it('keeps the chosen patient a choice through a search that does not match it, and after the search is dropped (PS-11)', async () => {
    answer(() => json(pageOf([patient(42)], 1, 1)));
    const field = await open();
    await userEvent.selectOptions(picker(), patient(3).id);
    await userEvent.type(field, 'SYN-42{Enter}');
    await screen.findByRole('option', { name: 'SYN-42' });
    expect(optionLabels()).toEqual(['Choose an existing patient…', 'SYN-3', 'SYN-42']);
    expect(picker()).toHaveValue(patient(3).id);
    await userEvent.clear(field);
    expect(await screen.findByRole('option', { name: 'SYN-20' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'SYN-42' })).not.toBeInTheDocument();
    expect(picker()).toHaveValue(patient(3).id);
    expect(screen.getByRole('button', { name: 'Next patients' })).toBeInTheDocument();
  });

  it('Enter in the field searches and never submits the upload', async () => {
    answer(() => json(pageOf([patient(42)], 1, 1)));
    const field = await open();
    await userEvent.type(field, 'SYN-42{Enter}');
    await screen.findByRole('option', { name: 'SYN-42' });
    expect(submitReport).not.toHaveBeenCalled();
    // A submit would have validated the empty form and named its first missing field.
    expect(screen.queryByText('Choose a report type.')).not.toBeInTheDocument();
  });

  it('on any answer but a 200, keeps the loaded choices and says the whole list was not searched, with Retry (PS-10)', async () => {
    answer(() => json({}, 500));
    const field = await open();
    await userEvent.type(field, 'SYN-42');
    await userEvent.click(screen.getByRole('button', { name: 'Search all patients' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(FAILED);
    expect(optionLabels()).toContain('SYN-20');
    expect(field).toHaveAccessibleDescription('The list below shows one page at a time. Search all patients looks through every one.');
    await userEvent.click(within(screen.getByRole('alert').parentElement!).getByRole('button', { name: 'Retry searching all patients' }));
    await vi.waitFor(() => expect(searches()).toHaveLength(2));
  });

  it('never sends a text the label alphabet refuses', async () => {
    answer(() => json(pageOf([], 1, 0)));
    const field = await open();
    await userEvent.type(field, 'SYN%{Enter}');
    expect(field).toHaveAccessibleDescription(expect.stringContaining('Use letters, numbers and hyphens only.'));
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(searches()).toEqual([]);
  });

  it('offers no search when every patient fits on one page', async () => {
    answer(() => json(pageOf([], 1, 0)), true);
    render(<UploadReportPage />, { wrapper: MemoryRouter });
    await screen.findByRole('option', { name: 'SYN-20' });
    expect(screen.queryByRole('textbox', { name: 'Find a patient' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Search all patients' })).not.toBeInTheDocument();
  });

  it('a newer search wins: the earlier request is aborted and its late answer dropped (PS-12)', async () => {
    let answerFirst: (response: Response) => void = () => undefined;
    answer((url) =>
      url.searchParams.get('labelContains') === 'SYN-4'
        ? new Promise<Response>((resolve) => {
            answerFirst = resolve;
          })
        : json(pageOf([patient(41)], 1, 1)),
    );
    const field = await open();
    await userEvent.type(field, 'SYN-4{Enter}');
    await vi.waitFor(() => expect(searches()).toHaveLength(1));
    await userEvent.type(field, '1{Enter}');
    await screen.findByRole('option', { name: 'SYN-41' });
    const first = apiFetch.mock.calls.find(([path]) => path.endsWith('labelContains=SYN-4'))!;
    expect(first[1]?.signal?.aborted).toBe(true);
    answerFirst(json(pageOf([patient(4), patient(40)], 1, 2)));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(optionLabels()).toEqual(['Choose an existing patient…', 'SYN-41']);
  });
});
