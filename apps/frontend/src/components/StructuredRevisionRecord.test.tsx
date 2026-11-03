import { readFileSync } from 'node:fs';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import type { StructuredPreview } from '@telesphoros/shared-types';
import { StructuredRevisionRecord } from './StructuredRevisionRecord';
const auth = vi.hoisted(() => ({ apiFetch: vi.fn(), roles: ['reviewer'] as string[] }));
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
  review: { status: 'not-reviewable', findings: [], outstanding: [], evidenceOnly: true },
  conflict: null,
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
  selection: null,
};
const finding = {
  findingId: 'syn-finding-a',
  targetId: 'syn-target-a',
  gene: 'GENEA',
  coverage: 'tested',
  analyticalState: 'ambiguous',
  interpretationState: 'indeterminate',
  decision: 'unreviewed',
  reasonCode: null,
  decidedAt: null,
  actionable: false,
};
const awaiting = { status: 'awaiting-review', findings: [finding], outstanding: ['review-findings'], evidenceOnly: true };
const saved = { ...empty, state: 'candidate-for-review', record: item, history: [item], review: awaiting };
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

const reviewed = {
  status: 'complete',
  findings: [{ ...finding, decision: 'accepted-as-evidence', reasonCode: 'matches-source', decidedAt: '2026-11-03T00:00:00Z' }],
  outstanding: [],
  evidenceOnly: true,
};
it('shows each saved finding with its uncertainty and records an exact, evidence-only decision', async () => {
  auth.apiFetch.mockResolvedValueOnce(response(saved));
  const { container } = render(<StructuredRevisionRecord preview={preview} />);
  await screen.findByText('Awaiting independent review');
  const list = screen.getByRole('list', { name: 'Findings for review' });
  expect(list).toHaveTextContent('GENEA');
  expect(list).toHaveTextContent('analytical result ambiguous');
  expect(list).toHaveTextContent('interpretation indeterminate');
  expect(screen.getByRole('list', { name: 'Outstanding actions' })).toHaveTextContent('Check each saved finding against its source');
  expect(screen.getByText(/does not approve prescribing or any clinical use/)).toBeVisible();
  auth.apiFetch.mockResolvedValueOnce(response({ ...saved, review: reviewed }));
  await userEvent.click(screen.getByRole('button', { name: 'GENEA: Matches source' }));
  await screen.findByText('Findings review complete');
  const [url, init] = auth.apiFetch.mock.calls.find(([, options]) => options?.method === 'POST')!;
  expect(url).toBe(`/api/v1/reports/${reportId}/structured-preview/review`);
  expect(JSON.parse(init.body)).toEqual({
    requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    revisionId: item.id,
    patientId,
    sha256: preview.source.sha256,
    objectVersion: preview.source.objectVersion,
    patientLinkDecisionId: decision.id,
    findingId: 'syn-finding-a',
    decision: 'accepted-as-evidence',
    reasonCode: 'matches-source',
  });
  expect(screen.getByRole('list', { name: 'Findings for review' })).toHaveTextContent('Matches its source');
  // Accepting a finding as evidence leaves its uncertainty on screen and adds no interpretation or prescribing action.
  expect(screen.getByRole('list', { name: 'Findings for review' })).toHaveTextContent('interpretation indeterminate');
  expect(screen.queryByRole('list', { name: 'Outstanding actions' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /prescrib|approve|interpret|release/i })).not.toBeInTheDocument();
  expect(await axe(container)).toHaveNoViolations();
});
it('offers no decision buttons to someone without the reviewer role', async () => {
  auth.roles = ['clinician'];
  try {
    auth.apiFetch.mockResolvedValueOnce(response(saved));
    render(<StructuredRevisionRecord preview={preview} />);
    await screen.findByText('Awaiting independent review');
    expect(screen.getByText(/A reviewer who did not upload or save this evidence/)).toBeVisible();
    expect(screen.queryByRole('button', { name: /Matches source/ })).not.toBeInTheDocument();
  } finally {
    auth.roles = ['reviewer'];
  }
});
it('clears an uncertain decision and requires a fresh read', async () => {
  auth.apiFetch.mockResolvedValueOnce(response(saved));
  render(<StructuredRevisionRecord preview={preview} />);
  auth.apiFetch.mockRejectedValueOnce(new Error('connection lost'));
  await userEvent.click(await screen.findByRole('button', { name: 'GENEA: Does not match' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('may already have been recorded');
  expect(screen.queryByRole('button', { name: /Does not match/ })).not.toBeInTheDocument();
  auth.apiFetch.mockResolvedValueOnce(response({ ...saved, review: reviewed }));
  await userEvent.click(screen.getByRole('button', { name: 'Reload saved findings' }));
  await screen.findByText('Findings review complete');
  expect(auth.apiFetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
});
const other = {
  ...item,
  id: '66666666-6666-4666-8666-666666666666',
  reportId: '77777777-7777-4777-8777-777777777777',
  laboratoryReportId: 'syn-report-1',
  createdAt: '2026-11-02T01:00:00Z',
};
const conflict = { laboratoryId: 'syn-lab-1', seriesId: 'syn-series-1', revision: 1, revisionIds: [item.id, other.id], resolution: null };
const held = {
  ...saved,
  state: 'held',
  reasons: ['duplicate-revision-content'],
  history: [item, other],
  conflict,
  review: { status: 'not-reviewable', findings: saved.review.findings, outstanding: ['resolve-source-conflict'], evidenceOnly: true },
};
it('handles a source conflict only by an explicit, complete decision and keeps every source', async () => {
  auth.apiFetch.mockResolvedValueOnce(response(held));
  const { container } = render(<StructuredRevisionRecord preview={preview} />);
  await screen.findByText('Saved · reconciliation needed');
  expect(screen.getByRole('list', { name: 'Outstanding actions' })).toHaveTextContent('Choose between the conflicting sources');
  expect(screen.queryByRole('button', { name: /Matches source/ })).not.toBeInTheDocument(); // findings stay closed while sources conflict
  const submit = screen.getByRole('button', { name: 'Record source decision' });
  expect(submit).toBeDisabled(); // nothing is preselected
  expect(await axe(container)).toHaveNoViolations();
  await userEvent.click(screen.getAllByRole('radio')[1]);
  auth.apiFetch.mockResolvedValueOnce(
    response({
      ...held,
      state: 'candidate-for-review',
      reasons: [],
      history: [
        { ...item, selection: 'not-selected' },
        { ...other, selection: 'selected' },
      ],
      conflict: {
        ...conflict,
        resolution: {
          id: '88888888-8888-4888-8888-888888888888',
          outcome: 'use-revision',
          chosenRevisionId: other.id,
          reasonCode: 'verified-against-laboratory',
          createdAt: '2026-11-03T00:00:00Z',
        },
      },
      review: awaiting,
    }),
  );
  await userEvent.click(submit);
  await screen.findByText('Awaiting independent review');
  const [url, init] = auth.apiFetch.mock.calls.find(([, options]) => options?.method === 'POST')!;
  expect(url).toBe(`/api/v1/reports/${reportId}/structured-preview/source-resolution`);
  expect(JSON.parse(init.body)).toEqual({
    requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    patientId,
    laboratoryId: 'syn-lab-1',
    seriesId: 'syn-series-1',
    revision: 1,
    revisionIds: [item.id, other.id],
    outcome: 'use-revision',
    chosenRevisionId: other.id,
    reasonCode: 'verified-against-laboratory',
  });
  expect(screen.getByText(/Source decision recorded/)).toBeVisible();
  await userEvent.click(screen.getByText('Saved source history (2)'));
  expect(screen.getByRole('list', { name: 'Saved source history' })).toHaveTextContent('Not selected (kept in history)');
  expect(screen.getByRole('list', { name: 'Saved source history' })).toHaveTextContent('Selected after source decision');
});
it('records that no conflicting source is usable without selecting one', async () => {
  auth.apiFetch.mockResolvedValueOnce(response(held));
  render(<StructuredRevisionRecord preview={preview} />);
  await userEvent.click(await screen.findByRole('radio', { name: 'None of these is usable' }));
  auth.apiFetch.mockResolvedValueOnce(
    response({
      ...held,
      conflict: {
        ...conflict,
        resolution: {
          id: '88888888-8888-4888-8888-888888888888',
          outcome: 'none-usable',
          chosenRevisionId: null,
          reasonCode: 'cannot-establish',
          createdAt: '2026-11-03T00:00:00Z',
        },
      },
      review: { ...held.review, outstanding: ['await-new-source'] },
    }),
  );
  await userEvent.click(screen.getByRole('button', { name: 'Record source decision' }));
  await screen.findByText(/none of the conflicting sources is usable/);
  const body = JSON.parse(auth.apiFetch.mock.calls.find(([, options]) => options?.method === 'POST')![1].body);
  expect(body).toMatchObject({ outcome: 'none-usable', reasonCode: 'cannot-establish' });
  expect(body).not.toHaveProperty('chosenRevisionId');
  expect(screen.getByRole('list', { name: 'Outstanding actions' })).toHaveTextContent('Wait for a new or corrected laboratory source');
});
it('explains a refused decision as a refusal, not a lost reply', async () => {
  auth.apiFetch.mockResolvedValueOnce(response(saved));
  render(<StructuredRevisionRecord preview={preview} />);
  auth.apiFetch.mockResolvedValueOnce(new Response('{}', { status: 409 }));
  await userEvent.click(await screen.findByRole('button', { name: 'GENEA: Matches source' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('A reviewer who did not upload or save this evidence must record it');
  expect(screen.getByRole('alert')).not.toHaveTextContent('may already have been recorded');
});
