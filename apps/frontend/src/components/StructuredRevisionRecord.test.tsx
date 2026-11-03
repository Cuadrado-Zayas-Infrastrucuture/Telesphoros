import { readFileSync } from 'node:fs';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import type { StructuredPreview } from '@telesphoros/shared-types';
import { StructuredRevisionRecord } from './StructuredRevisionRecord';
const auth = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/auth/AuthProvider', () => ({ useAuth: () => auth }));
const reportId = '11111111-1111-4111-8111-111111111111';
const patientId = '22222222-2222-4222-8222-222222222222';
const decision = {
  id: '33333333-3333-4333-8333-333333333333',
  decision: 'verified' as const,
  method: 'person-confirmed' as const,
  basisCode: 'documented-clinic-procedure' as const,
  createdAt: '2026-11-01T00:00:00Z',
};
const preview: StructuredPreview = {
  reportId,
  patientId,
  patientLabel: 'SYN-CASE',
  source: { sha256: 'a'.repeat(64), objectVersion: 'version-one' },
  laboratoryReport: JSON.parse(readFileSync('../../data/fixtures/pgx-contracts/uncertain/package.json', 'utf8')).report,
  patientLink: { reportId, patientId, state: 'verified', decision, staleDecision: false },
  canReview: true,
  lineage: 'not-reconciled',
  synthetic: true,
  clinicalUse: 'not-approved',
  actionable: false,
};
const empty = {
  reportId,
  patientId,
  record: null,
  history: [],
  state: 'not-recorded',
  reasons: [],
  synthetic: true,
  clinicalUse: 'not-approved',
  actionable: false,
  independentReviewRequired: true,
};
const item = {
  id: '44444444-4444-4444-8444-444444444444',
  reportId,
  laboratoryId: 'syn-lab-1',
  seriesId: 'syn-series-1',
  laboratoryReportId: 'syn-report-1',
  revision: 1,
  status: 'final',
  createdAt: '2026-11-02T00:00:00Z',
  findingIds: ['syn-finding-a'],
  currentBinding: true,
};
const saved = { ...empty, state: 'candidate-for-review', record: item, history: [item] };
const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
beforeEach(() => {
  auth.apiFetch.mockReset();
  auth.apiFetch.mockImplementation(async () => response(empty));
});
it('saves only the expected source and review binding, then shows persisted history', async () => {
  const { container } = render(<StructuredRevisionRecord preview={preview} />);
  const save = await screen.findByRole('button', { name: 'Save findings for review' });
  auth.apiFetch.mockResolvedValueOnce(response(saved));
  await userEvent.click(save);
  await screen.findByText('Saved · ready for findings review');
  const [, init] = auth.apiFetch.mock.calls.find(([, options]) => options?.method === 'POST')!;
  expect(JSON.parse(init.body)).toEqual({ patientId, ...preview.source, sourcePatientReference: 'syn-patient-1', patientLinkDecisionId: decision.id });
  expect(screen.queryByRole('button', { name: 'Save findings for review' })).not.toBeInTheDocument();
  await userEvent.click(screen.getByText('Saved source history (1)'));
  expect(screen.getByRole('list', { name: 'Saved source history' })).toHaveTextContent('Revision 1 (final)');
  expect(await axe(container)).toHaveNoViolations();
});
it('requires a verified patient link before offering save', async () => {
  render(<StructuredRevisionRecord preview={{ ...preview, patientLink: { ...preview.patientLink, state: 'unverified', decision: null } }} />);
  await screen.findByText('Verify the patient link before saving findings for review.');
  expect(screen.queryByRole('button', { name: 'Save findings for review' })).not.toBeInTheDocument();
});
it('clears an uncertain save and requires a read before retrying', async () => {
  render(<StructuredRevisionRecord preview={preview} />);
  const save = await screen.findByRole('button', { name: 'Save findings for review' });
  auth.apiFetch.mockRejectedValueOnce(new Error('connection lost'));
  await userEvent.click(save);
  expect(await screen.findByRole('alert')).toHaveTextContent('may already have completed');
  expect(screen.queryByRole('button', { name: 'Save findings for review' })).not.toBeInTheDocument();
  auth.apiFetch.mockResolvedValueOnce(response(saved));
  await userEvent.click(screen.getByRole('button', { name: 'Reload saved findings' }));
  await screen.findByText('Saved · ready for findings review');
  expect(auth.apiFetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
});
it('explains holds and never offers a prescribing action', async () => {
  auth.apiFetch.mockResolvedValueOnce(response({ ...saved, state: 'held', reasons: ['duplicate-revision-content'] }));
  render(<StructuredRevisionRecord preview={preview} />);
  await screen.findByText('Saved · reconciliation needed');
  expect(screen.getByText('Different files claim the same laboratory revision.')).toBeVisible();
  expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Reload saved findings']);
});
it.each([{ patientId: '55555555-5555-4555-8555-555555555555' }, { actionable: true }])('refuses mismatched or actionable response: %j', async (over) => {
  auth.apiFetch.mockResolvedValueOnce(response({ ...saved, ...over }));
  render(<StructuredRevisionRecord preview={preview} />);
  await screen.findByRole('alert');
  expect(screen.queryByText('Saved · ready for findings review')).not.toBeInTheDocument();
});
it('aborts and ignores a late response after the report panel closes', async () => {
  let finish!: (response: Response) => void;
  auth.apiFetch.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  const { unmount } = render(<StructuredRevisionRecord preview={preview} />);
  await waitFor(() => expect(auth.apiFetch).toHaveBeenCalled());
  const signal = auth.apiFetch.mock.calls[0][1].signal as AbortSignal;
  unmount();
  expect(signal.aborted).toBe(true);
  await act(async () => finish(response(saved)));
  expect(screen.queryByText('Saved · ready for findings review')).not.toBeInTheDocument();
});
