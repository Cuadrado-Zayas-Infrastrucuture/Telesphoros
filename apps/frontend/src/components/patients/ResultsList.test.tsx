import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evaluationSummaryDtoSchema } from '@telesphoros/shared-types';
import { ResultsList } from './ResultsList';

const auth = vi.hoisted(() => ({ apiFetch: vi.fn(), roles: ['clinician'] as string[] }));
vi.mock('@/auth/AuthProvider', () => ({ useAuth: () => auth }));
// The panel stands in for a decision write the server refused with 409: it reports the result as stale to the list.
vi.mock('./DecisionPanel', () => ({ DecisionPanel: ({ onStale }: { onStale: () => void }) => <button onClick={onStale}>report stale result</button> }));

const patientId = '22222222-2222-4222-8222-222222222222';
const evaluation = {
  id: '66666666-6666-4666-8666-666666666666',
  reportId: '11111111-1111-4111-8111-111111111111',
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
  results: [
    {
      id: '55555555-5555-4555-8555-555555555555',
      ordinal: 0,
      drug: 'drugz',
      genes: ['GENEA', 'GENEB'],
      outcome: 'shown',
      reasonCode: null,
      strength: 'Strong',
      citation: { guidelineId: 'drugz-genea-geneb' },
      recommendationText: 'Z normal-low.',
      implication: null,
      geneEvidence: null,
    },
  ],
  geneStates: [],
  corrections: [],
  current: true,
  advisory: { activeDisputes: 0, patientLink: 'verified' },
  actionable: false,
  createdAt: '2026-11-04T00:00:00Z',
};
type Fixture = typeof evaluation;
const page = (...data: Fixture[]) => new Response(JSON.stringify({ data, meta: { page: 1, pageSize: 10, total: data.length, totalPages: 1 } }), { status: 200 });
const list = () => page(evaluation);
const variant = (change: { state?: string; current?: boolean; patientLink?: string }): Fixture => ({
  ...evaluation,
  state: change.state ?? evaluation.state,
  current: change.current ?? evaluation.current,
  advisory: { ...evaluation.advisory, patientLink: change.patientLink ?? evaluation.advisory.patientLink },
});
const show = () => render(<ResultsList patientId={patientId} followupBusy={false} onFollowup={() => undefined} />);

beforeEach(() => {
  auth.apiFetch.mockReset();
  auth.apiFetch.mockImplementation(async () => list());
});
afterEach(() => vi.unstubAllEnvs());

it('the fixture is a valid evaluation summary, so the cases below test the list and not the fixture', () => {
  expect(() => evaluationSummaryDtoSchema.parse(evaluation)).not.toThrow();
});

it('offers decisions on a stored result in an ordinary build (control for the staging case below)', async () => {
  show();
  expect(await screen.findByText('Z normal-low.')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Decision and history' })).toBeVisible();
  expect(screen.getByText(/Decisions below document intent only/)).toBeVisible();
});

it('shows the result and its source but offers no decisions in the synthetic staging, where they are not switched on', async () => {
  vi.stubEnv('VITE_SYNTHETIC_ASSESSMENT', 'true');
  show();
  expect(await screen.findByText('Z normal-low.')).toBeVisible();
  expect(screen.getByText(/Source and provenance/)).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Decision and history' })).not.toBeInTheDocument();
  expect(screen.queryByText(/Decisions below document intent only/)).not.toBeInTheDocument();
  expect(screen.getByText(/Clinical use is not approved/)).toBeVisible();
});

// A result that is not the current one must never read as current guidance: a notice says what happened and what to do, and its wording
// is folded behind a disclosure. A retracted or superseded evaluation is never current (the API derives `current` from the state).
const notCurrent = [
  ['retracted', variant({ state: 'retracted', current: false }), 'Withdrawn. Do not use this result.'],
  ['superseded', variant({ state: 'superseded', current: false }), 'Replaced by a newer result. Do not use this one.'],
  ['patient link rejected', variant({ current: false, patientLink: 'rejected' }), 'This report may belong to another patient. Do not use it.'],
  ['active but not current', variant({ current: false }), 'Not the current result for this report.'],
] as const;

it.each(notCurrent)('%s: a notice, and the wording only behind "Show the text anyway"', async (_name, fixture, notice) => {
  expect(() => evaluationSummaryDtoSchema.parse(fixture)).not.toThrow();
  auth.apiFetch.mockImplementation(async () => page(fixture));
  show();
  expect(await screen.findByText(notice)).toBeVisible();
  expect(screen.getByText('Z normal-low.')).not.toBeVisible();
  fireEvent.click(screen.getByText('Show the text anyway'));
  expect(screen.getByText('Z normal-low.')).toBeVisible();
  expect(screen.queryByText('Current evaluation')).not.toBeInTheDocument();
});

it('an unverified patient link is a caution, not a withdrawal: the wording stays readable', async () => {
  auth.apiFetch.mockImplementation(async () => page(variant({ patientLink: 'unverified' })));
  show();
  expect(await screen.findByText('Not yet confirmed that this report belongs to this patient.')).toBeVisible();
  expect(screen.getByText('Z normal-low.')).toBeVisible();
  expect(screen.queryByText('Show the text anyway')).not.toBeInTheDocument();
});

it('control: a current result with a verified link has no notice and its wording is shown', async () => {
  show();
  expect(await screen.findByText('Z normal-low.')).toBeVisible();
  expect(screen.getByText('Current evaluation')).toBeVisible();
  for (const [, , notice] of notCurrent) expect(screen.queryByText(notice)).not.toBeInTheDocument();
  expect(screen.queryByText('Show the text anyway')).not.toBeInTheDocument();
  expect(screen.getByText(/^Updated /)).toBeVisible();
});

const retractedLater = async (trigger: () => void) => {
  auth.apiFetch.mockImplementationOnce(async () => list()).mockImplementation(async () => page(variant({ state: 'retracted', current: false })));
  show();
  expect(await screen.findByText('Z normal-low.')).toBeVisible();
  expect(screen.queryByText('Withdrawn. Do not use this result.')).not.toBeInTheDocument();
  act(trigger);
  expect(await screen.findByText('Withdrawn. Do not use this result.')).toBeVisible();
  expect(screen.getByText('Z normal-low.')).not.toBeVisible();
  expect(auth.apiFetch).toHaveBeenCalledTimes(2);
};

it('re-reads the list when the window regains focus: a retraction made meanwhile shows without a manual reload', async () => {
  await retractedLater(() => window.dispatchEvent(new Event('focus')));
});

it('re-reads the list when the tab becomes visible again', async () => {
  await retractedLater(() => document.dispatchEvent(new Event('visibilitychange')));
});

it('re-reads the list when a decision write was refused because the result changed (409)', async () => {
  auth.apiFetch.mockImplementationOnce(async () => list()).mockImplementation(async () => page(variant({ state: 'retracted', current: false })));
  show();
  fireEvent.click(await screen.findByRole('button', { name: 'Decision and history' }));
  fireEvent.click(screen.getByRole('button', { name: 'report stale result' }));
  expect(await screen.findByText('Withdrawn. Do not use this result.')).toBeVisible();
  expect(auth.apiFetch).toHaveBeenCalledTimes(2);
});

it('a hidden tab does not re-read the list (control for the visibility case)', async () => {
  show();
  expect(await screen.findByText('Z normal-low.')).toBeVisible();
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  visibility.mockRestore();
  expect(auth.apiFetch).toHaveBeenCalledTimes(1);
});
