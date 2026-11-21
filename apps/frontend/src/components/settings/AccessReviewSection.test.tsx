import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccessReviewSection } from './AccessReviewSection';

// Spec 046 T-8. Synthetic ids only; the expected rows are written by hand.
const PATIENT = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const page = (data: unknown[], hasMore = false, n = 1) => ({ data, page: n, hasMore, from: '2026-11-01T00:00:00.000Z', to: '2026-11-21T00:00:00.000Z' });
const row = (over: Record<string, unknown> = {}) => ({
  occurredAt: '2026-11-20T10:00:00.000Z',
  member: 'syn-clinician',
  routeKey: 'PatientsController.get',
  event: 'private-read',
  outcome: 'succeeded',
  subjectKind: 'patient',
  subjectId: PATIENT,
  patientId: PATIENT,
  ...over,
});

afterEach(() => vi.restoreAllMocks());

async function lookUp(apiFetch: ReturnType<typeof vi.fn>, value = PATIENT) {
  const { container } = render(<AccessReviewSection apiFetch={apiFetch as never} />);
  await userEvent.type(screen.getByLabelText('Patient id'), value);
  await userEvent.click(screen.getByRole('button', { name: 'Show reads' }));
  return container;
}

describe('Access review (Settings)', () => {
  it('lists the reads of a patient, by member, what, outcome and patient id, and asks the API with the patient and the window', async () => {
    const apiFetch = vi.fn<(path: string) => Promise<Response>>(async () =>
      json(page([row(), row({ routeKey: 'ReportsController.downloadUrl', event: 'download-link', outcome: 'refused', subjectKind: 'report' })])),
    );
    const container = await lookUp(apiFetch);
    const table = await screen.findByRole('table', { name: 'Reads of patient records' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('syn-clinician')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('Allowed')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Refused')).toBeInTheDocument();
    expect(within(rows[1]!).getByText(/Report file link/)).toBeInTheDocument();
    const url = new URL(String(apiFetch.mock.calls[0]![0]), 'https://api.example.test');
    expect(url.pathname).toBe('/api/v1/access-review');
    expect(url.searchParams.get('patientId')).toBe(PATIENT);
    expect(url.searchParams.get('member')).toBeNull();
    expect(Date.parse(url.searchParams.get('from')!)).toBeLessThan(Date.parse(url.searchParams.get('to')!));
    expect(await axe(container)).toHaveNoViolations();
  });

  it('says "Not a patient record" for a read the audit cannot tie to a patient, and "No reads" when nothing matched', async () => {
    await lookUp(vi.fn(async () => json(page([row({ routeKey: 'UsageController.get', subjectKind: 'other', subjectId: null, patientId: null })]))));
    expect(await screen.findByText('Not a patient record')).toBeInTheDocument();
  });

  it('says so when nothing matched', async () => {
    await lookUp(vi.fn(async () => json(page([]))));
    expect(await screen.findByText('No reads in this window.')).toBeInTheDocument();
  });

  it('never makes a failure look like "no reads": a 500, a refusal and a bad filter each say what happened', async () => {
    for (const [status, text] of [
      [500, 'The access review could not be loaded. Try again.'],
      [403, 'Only administrators of this organization can review access.'],
      [400, 'Check the filter: choose a patient id or a member, and at most 92 days.'],
    ] as const) {
      const { unmount } = render(<AccessReviewSection apiFetch={vi.fn(async () => json({}, status)) as never} />);
      await userEvent.click(screen.getByRole('button', { name: 'Show reads' }));
      expect(await screen.findByText(text)).toBeInTheDocument();
      expect(screen.queryByText('No reads in this window.')).not.toBeInTheDocument();
      unmount();
    }
  });

  it('pages with Previous and Next, and downloads the CSV of what is shown', async () => {
    const apiFetch = vi.fn(async (path: string) =>
      path.includes('/export') ? new Response('h\n', { status: 200 }) : json(page([row()], !path.includes('page=2'), path.includes('page=2') ? 2 : 1)),
    );
    const created = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    await lookUp(apiFetch);
    await userEvent.click(await screen.findByRole('button', { name: 'Next' }));
    expect(String(apiFetch.mock.calls.at(-1)![0])).toContain('page=2');
    expect(await screen.findByRole('button', { name: 'Previous' })).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: 'Download CSV' }));
    expect(String(apiFetch.mock.calls.at(-1)![0])).toMatch(/^\/api\/v1\/access-review\/export\?/);
    expect(created).toHaveBeenCalled();
    expect(click).toHaveBeenCalled();
    expect(await screen.findByText('The file is downloaded.')).toBeInTheDocument();
  });
});
