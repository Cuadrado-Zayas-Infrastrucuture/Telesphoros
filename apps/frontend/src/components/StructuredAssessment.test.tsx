import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { evaluationDtoSchema, type StructuredPreview, type StructuredRecordState } from '@telesphoros/shared-types';
import { StructuredAssessment } from './StructuredAssessment';

const auth = vi.hoisted(() => ({ apiFetch: vi.fn(), roles: ['clinician'] as string[] }));
vi.mock('@/auth/AuthProvider', () => ({ useAuth: () => auth }));

const reportId = '11111111-1111-4111-8111-111111111111';
const patientId = '22222222-2222-4222-8222-222222222222';
const preview = { reportId, patientId } as StructuredPreview;
const record = {
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
const stateOf = (over: { state?: string; status?: string; record?: typeof record | null } = {}) =>
  ({
    reportId,
    patientId,
    record: over.record === undefined ? record : over.record,
    history: [],
    state: over.state ?? 'candidate-for-review',
    reasons: [],
    review: { status: over.status ?? 'complete', findings: [], outstanding: [], evidenceOnly: true },
    conflict: null,
    synthetic: true,
    clinicalUse: 'not-approved',
    actionable: false,
    independentReviewRequired: true,
  }) as StructuredRecordState;

const result = (over: object = {}) => ({
  id: '55555555-5555-4555-8555-555555555555',
  ordinal: 0,
  drug: 'drugz',
  genes: ['GENEA', 'GENEB'],
  outcome: 'shown',
  reasonCode: null,
  strength: 'Strong',
  citation: { guidelineId: 'drugz-genea-geneb', guidelineVersion: 'synthetic-1', locator: { table: 'Synthetic Table 3', row: 'Synthetic Normal', column: 'Synthetic Low' } },
  recommendationText: 'Z normal-low.',
  implication: null,
  geneEvidence: null,
  ...over,
});
const evaluation = (over: object = {}) => ({
  id: '66666666-6666-4666-8666-666666666666',
  reportId,
  patientId,
  captureId: null,
  acceptance: null,
  disposition: 'evaluated',
  holdCode: null,
  hold: null,
  knowledgeSetId: 'a'.repeat(64),
  engineVersion: 'sha256-abcdef012345',
  scope: 'synthetic-structured-assessment',
  clinicalUse: 'not-approved',
  state: 'active',
  supersededBy: null,
  results: [result()],
  geneStates: [],
  geneInputs: [],
  corrections: [],
  current: true,
  advisory: { activeDisputes: 0, patientLink: 'verified' },
  actionable: false,
  createdAt: '2026-11-04T00:00:00Z',
  ...over,
});
const reply = (body: unknown, status = 201) => new Response(JSON.stringify(body), { status });
const show = (state = stateOf()) =>
  render(
    <MemoryRouter>
      <StructuredAssessment preview={preview} state={state} />
    </MemoryRouter>,
  );
const run = () => screen.getByRole('button', { name: 'Run synthetic assessment' });

beforeEach(() => {
  auth.roles = ['clinician'];
  auth.apiFetch.mockReset();
});

it('the fixture is a valid evaluation, so the cases below test the component and not the fixture', () => {
  expect(() => evaluationDtoSchema.parse(evaluation())).not.toThrow();
});

it.each(['awaiting-review', 'in-progress', 'not-reviewable'])('cannot run before every finding has a decision (%s), and says why', (status) => {
  show(stateOf({ status }));
  expect(run()).toBeDisabled();
  expect(screen.getByText('Available once every saved finding has an independent decision.')).toBeVisible();
});

it.each(['complete', 'attention'])('can run once every finding has a decision (%s)', (status) => {
  show(stateOf({ status }));
  expect(run()).toBeEnabled();
  expect(screen.queryByText(/Available once every saved finding/)).not.toBeInTheDocument();
});

it.each([
  ['a source reconciliation is open', stateOf({ state: 'held' })],
  ['a newer revision supersedes it', stateOf({ state: 'superseded' })],
  ['nothing is saved', stateOf({ record: null, state: 'not-recorded' })],
])('cannot run when %s, even with a complete review', (_name, state) => {
  show(state);
  expect(run()).toBeDisabled();
});

it('cannot run for a candidate state that holds no saved record (a state the server does not send, kept closed anyway)', () => {
  show(stateOf({ record: null }));
  expect(run()).toBeDisabled();
});

it('posts to the assessment route of this report with no body, then shows the stored result, its citation and a link to the patient', async () => {
  auth.apiFetch.mockResolvedValue(reply(evaluation()));
  show();
  await userEvent.click(run());
  expect(auth.apiFetch).toHaveBeenCalledTimes(1);
  const [path, init] = auth.apiFetch.mock.calls[0]!;
  expect(path).toBe(`/api/v1/reports/${reportId}/structured-assessment`);
  expect(init.method).toBe('POST');
  expect(init.body).toBeUndefined();
  const shown = await screen.findByRole('status', { name: 'Assessment result' });
  expect(shown).toHaveTextContent('Stored just now.');
  expect(shown).toHaveTextContent('drugz');
  expect(shown).toHaveTextContent('Recommendation');
  expect(shown).toHaveTextContent('GENEA · GENEB');
  expect(shown).toHaveTextContent('Outcome code: shown');
  expect(shown).toHaveTextContent('Z normal-low.');
  expect(shown).toHaveTextContent('Recorded strength: Strong');
  expect(shown).toHaveTextContent('Synthetic Table 3');
  expect(screen.getByRole('link', { name: /stored results/ })).toHaveAttribute('href', `/patients/${patientId}`);
  expect(screen.getByText(/Clinical use is not approved/)).toBeVisible();
});

it('says when the same assessment was already stored (200), and shows a held assessment with its fixed wording and no results', async () => {
  auth.apiFetch.mockResolvedValueOnce(reply(evaluation(), 200));
  show();
  await userEvent.click(run());
  expect(await screen.findByText('The same assessment was already stored.')).toBeVisible();
  auth.apiFetch.mockResolvedValueOnce(
    reply(
      evaluation({
        disposition: 'held',
        holdCode: 'findings-not-reviewed',
        hold: { message: 'A second person has not yet accepted every finding.', reviewerAction: 'Accept or reject each finding.' },
        results: [],
      }),
    ),
  );
  await userEvent.click(run());
  expect(await screen.findByText(/Held: A second person has not yet accepted every finding\. Accept or reject each finding\./)).toBeVisible();
  expect(screen.queryByText('Z normal-low.')).not.toBeInTheDocument();
});

it.each([
  [409, /refused: the saved evidence is not ready or has changed/],
  [503, /not switched on in this environment/],
  [403, /role cannot run an assessment/],
  [500, /could not be confirmed/],
])('shows fixed wording for a %s answer, never the server text, and no result', async (status, message) => {
  auth.apiFetch.mockResolvedValue(new Response('untrusted-private-detail', { status }));
  show();
  await userEvent.click(run());
  expect(await screen.findByRole('alert')).toHaveTextContent(message);
  expect(document.body.textContent).not.toContain('untrusted-private-detail');
  expect(screen.queryByRole('status', { name: 'Assessment result' })).not.toBeInTheDocument();
});

it('refuses an answer about another report or patient, and an answer that is not an evaluation', async () => {
  auth.apiFetch.mockResolvedValueOnce(reply(evaluation({ reportId: '77777777-7777-4777-8777-777777777777' })));
  show();
  await userEvent.click(run());
  expect(await screen.findByRole('alert')).toBeVisible();
  auth.apiFetch.mockResolvedValueOnce(reply(evaluation({ patientId: '77777777-7777-4777-8777-777777777777' })));
  await userEvent.click(run());
  await waitFor(() => expect(screen.getByRole('alert')).toBeVisible());
  auth.apiFetch.mockResolvedValueOnce(reply({ surprise: true }));
  await userEvent.click(run());
  await waitFor(() => expect(screen.getByRole('alert')).toBeVisible());
  expect(screen.queryByRole('status', { name: 'Assessment result' })).not.toBeInTheDocument();
});

it('cannot be clicked twice while running', async () => {
  let finish!: (r: Response) => void;
  auth.apiFetch.mockImplementation(() => new Promise<Response>((resolve) => (finish = resolve)));
  show();
  await userEvent.click(run());
  expect(screen.getByRole('button', { name: 'Running the synthetic assessment…' })).toBeDisabled();
  expect(auth.apiFetch).toHaveBeenCalledTimes(1);
  finish(reply(evaluation()));
  expect(await screen.findByRole('status', { name: 'Assessment result' })).toBeVisible();
});

it.each(['reader', 'admin'])('shows nothing to a %s', (role) => {
  auth.roles = [role];
  const { container } = show();
  expect(container).toBeEmptyDOMElement();
});

it('has no accessibility violations with a result shown', async () => {
  auth.apiFetch.mockResolvedValue(reply(evaluation()));
  const { container } = show();
  await userEvent.click(run());
  await screen.findByRole('status', { name: 'Assessment result' });
  expect(await axe(container)).toHaveNoViolations();
});
