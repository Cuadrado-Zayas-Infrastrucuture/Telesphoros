import { act, fireEvent, render, screen, within } from '@testing-library/react';
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
  advisory: { activeDisputes: 0, patientLink: 'verified', knowledge: { evaluatedWith: 'set', loadedNow: 'set', status: 'same' } },
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

// Specs/038 D4: a result a decision can be recorded on shows its decision controls with the result, without a click. `PANEL` is the stand-in above.
const PANEL = { name: 'report stale result' };

it('shows the decision controls with a current recommendation in an ordinary build, without a click (control for the staging case below)', async () => {
  show();
  expect(await screen.findByText('Z normal-low.')).toBeVisible();
  expect(screen.getByRole('button', PANEL)).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Decision history' })).not.toBeInTheDocument();
  expect(screen.getByText(/Decisions below document intent only/)).toBeVisible();
});

it('shows the result and its source but offers no decisions in the synthetic staging, where they are not switched on', async () => {
  vi.stubEnv('VITE_SYNTHETIC_ASSESSMENT', 'true');
  show();
  expect(await screen.findByText('Z normal-low.')).toBeVisible();
  expect(within(screen.getByLabelText('Source')).getByText('drugz-genea-geneb · version not recorded')).toBeVisible();
  expect(screen.getByText('Technical provenance')).toBeVisible();
  expect(screen.queryByRole('button', PANEL)).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Decision history' })).not.toBeInTheDocument();
  expect(screen.queryByText(/Decisions below document intent only/)).not.toBeInTheDocument();
  expect(screen.getByText(/Clinical use is not approved/)).toBeVisible();
});

const other = (ordinal: number, drug: string, outcome: string, reasonCode: string | null, text: string | null = null) => ({
  ...evaluation.results[0]!,
  id: `55555555-5555-4555-8555-5555555556${String(ordinal).padStart(2, '0')}`,
  ordinal,
  drug,
  outcome,
  reasonCode,
  strength: outcome === 'shown' ? 'Strong' : null,
  citation: outcome === 'shown' ? evaluation.results[0]!.citation : null,
  recommendationText: text,
});
/** Opens a result's row. The name is what a screen reader hears: the plain drug name, then the outcome in words. */
const openRow = (drug: string, outcome: string) => fireEvent.click(screen.getByRole('button', { name: `${drug}: ${outcome}` }));

// The three ways a drug has no recommendation stay three different things, and none of them offers a decision.
it('held, no guideline and a guideline that gives no recommendation read differently, and each says why no decision can be recorded', async () => {
  const mixed = {
    ...evaluation,
    results: [
      other(0, 'drugheld', 'held', 'cell-disputed'),
      other(1, 'drugnone', 'no-guideline', 'no-guideline-for-drug'),
      other(2, 'drugsilent', 'no-published-recommendation', 'no-published-recommendation'),
    ],
  };
  expect(() => evaluationSummaryDtoSchema.parse(mixed)).not.toThrow();
  auth.apiFetch.mockImplementation(async () => page(mixed as never));
  show();
  // Every row says its outcome without a click, so the three are told apart at a glance.
  const held = within(await screen.findByRole('region', { name: 'Stored result drugheld' }));
  const none = within(screen.getByRole('region', { name: 'Stored result drugnone' }));
  const silent = within(screen.getByRole('region', { name: 'Stored result drugsilent' }));
  expect(held.getByText('On hold: needs review')).toBeVisible();
  expect(none.getByText('No guideline for this drug')).toBeVisible();
  expect(silent.getByText('The guideline gives no recommendation for this case')).toBeVisible();
  const cases = [
    [held, 'drugheld', 'On hold: needs review', 'The guideline cell for this case is under dispute.'],
    [none, 'drugnone', 'No guideline for this drug', 'No loaded guideline covers this drug.'],
    [silent, 'drugsilent', 'The guideline gives no recommendation for this case', 'The guideline publishes no recommendation for this case.'],
  ] as const;
  for (const [section, drug, outcome, missing] of cases) {
    if (section !== held) openRow(drug, outcome); // the first current result is open already
    expect(section.getByText('No recommendation is shown for this drug, so there is no decision to record.')).toBeVisible();
    expect(section.queryByRole('button', PANEL)).not.toBeInTheDocument();
    expect(section.queryByText('Recommendation')).not.toBeInTheDocument();
    // Each is a gap in the guidelines, not in the patient's report, and the evidence says which.
    const gap = within(section.getByRole('region', { name: 'What is missing?' }));
    expect(gap.getByText(missing)).toBeVisible();
    expect(gap.getByText('From the guidelines and definitions')).toBeVisible();
    expect(gap.queryByText(/From the report/)).not.toBeInTheDocument();
  }
});

// Specs/038 D7: the evidence beside a result is a view of what the result carries. A gene with no usable result is missing, never normal.
it('says which gene results an assessment used, which it lacked and whose gap that is, and assumes nothing for a gene with no state', async () => {
  const partial = {
    ...evaluation,
    geneStates: [
      { gene: 'GENEA', state: 'canonical', phenotype: 'Poor Metabolizer', diplotype: '*2/*3', activityScore: '0.0', reasonCode: null },
      { gene: 'GENEB', state: 'absent', phenotype: null, diplotype: null, activityScore: null, reasonCode: 'gene-absent' },
    ],
    results: [{ ...other(0, 'drugheld', 'held', 'gene-absent'), genes: ['GENEA', 'GENEB', 'GENEC'] }],
  };
  expect(() => evaluationSummaryDtoSchema.parse(partial)).not.toThrow();
  auth.apiFetch.mockImplementation(async () => page(partial as never));
  show();
  const evidence = within(await screen.findByRole('complementary', { name: 'Evidence for drugheld' }));
  const used = within(evidence.getByRole('region', { name: 'What the assessment used' }));
  expect(used.getByText(/GENEA: Poor Metabolizer/)).toBeVisible();
  expect(used.getByText('(diplotype *2/*3, activity score 0.0)')).toBeVisible();
  expect(used.getByText('GENEC: no state was recorded with this result. It is not assumed.')).toBeVisible();
  expect(used.getByText('Not used by this assessment: the medication list and the demographics. They are recorded in the chart only.')).toBeVisible();
  expect(used.queryByText(/GENEB/)).not.toBeInTheDocument();
  const gap = within(evidence.getByRole('region', { name: 'What is missing?' }));
  expect(gap.getByText('From the report · GENEB')).toBeVisible();
  // Said once: the result's own reason is the gene's reason.
  expect(gap.getAllByText('The report has no result for a gene this guideline needs.')).toHaveLength(1);
  expect(gap.getByText("A reviewer's next step: Obtain the missing gene result from the lab.")).toBeVisible();
  expect(evidence.queryByText(/Normal/)).not.toBeInTheDocument();
  expect(within(evidence.getByRole('region', { name: 'Show the source' })).getByText('This outcome has no guideline wording, so there is no source to show.')).toBeVisible();
  // Nothing changed, so that part is not shown at all.
  expect(evidence.queryByRole('region', { name: 'What changed?' })).not.toBeInTheDocument();
});

it('a reason this screen does not know is reported as unknown, with no next step invented', async () => {
  const unknown = { ...evaluation, results: [other(0, 'drugheld', 'held', 'some-later-reason')] };
  auth.apiFetch.mockImplementation(async () => page(unknown as never));
  show();
  const gap = within(await screen.findByRole('region', { name: 'What is missing?' }));
  expect(gap.getByText(/The reason is not one this screen knows/)).toBeVisible();
  expect(gap.getByText('Nothing can be done about this in the product yet.')).toBeVisible();
});

it('a recommendation says why it applies, and "What changed?" appears only when the guidelines differ or cannot be confirmed', async () => {
  show();
  const evidence = within(await screen.findByRole('complementary', { name: 'Evidence for drugz' }));
  expect(evidence.getByRole('region', { name: 'Why this applies' })).toBeVisible();
  expect(within(evidence.getByRole('region', { name: 'What is missing?' })).getByText('Nothing the assessment needed is recorded as missing.')).toBeVisible();
  expect(evidence.queryByRole('region', { name: 'What changed?' })).not.toBeInTheDocument();
});

it.each([
  ['changed', 'The guidelines loaded now are not the set this result was made with. That says only that they differ, not what differs.'],
  ['unknown', 'It could not be confirmed that this result used the guidelines in use now.'],
])('guidelines %s: "What changed?" says exactly that', async (status, message) => {
  const fixture = { ...evaluation, advisory: { ...evaluation.advisory, knowledge: { evaluatedWith: 'set', loadedNow: status === 'changed' ? 'next' : null, status } } };
  expect(() => evaluationSummaryDtoSchema.parse(fixture)).not.toThrow();
  auth.apiFetch.mockImplementation(async () => page(fixture as never));
  show();
  expect(within(await screen.findByRole('region', { name: 'What changed?' })).getByText(message)).toBeVisible();
});

// One result is open at a time, so a long list stays readable and only one decision history is read.
it('twenty-two drugs: every row says its outcome, one result is open, and one decision history is read', async () => {
  const many = { ...evaluation, results: Array.from({ length: 22 }, (_, index) => other(index, `drug${index}`, 'shown', null, `Text for drug${index}.`)) };
  expect(() => evaluationSummaryDtoSchema.parse(many)).not.toThrow();
  auth.apiFetch.mockImplementation(async () => page(many as never));
  show();
  expect(await screen.findByText('Text for drug0.')).toBeVisible();
  expect(screen.getAllByRole('region', { name: /^Stored result drug/ })).toHaveLength(22);
  expect(screen.getAllByText('Recommendation')).toHaveLength(22);
  expect(screen.getAllByRole('button', PANEL)).toHaveLength(1);
  expect(screen.queryByText('Text for drug21.')).not.toBeInTheDocument();
  openRow('drug21', 'Recommendation');
  expect(screen.getByText('Text for drug21.')).toBeVisible();
  expect(screen.queryByText('Text for drug0.')).not.toBeInTheDocument();
  expect(screen.getAllByRole('button', PANEL)).toHaveLength(1);
  // A re-read (the window regains focus) does not move the reader's choice.
  act(() => window.dispatchEvent(new Event('focus')));
  expect(await screen.findByText('Text for drug21.')).toBeVisible();
  // Closing it leaves every row, and no detail.
  openRow('drug21', 'Recommendation');
  expect(screen.queryByText('Text for drug21.')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', PANEL)).not.toBeInTheDocument();
});

it('opens the current result first even when an earlier, withdrawn one is listed above it', async () => {
  const withdrawn = { ...variant({ state: 'retracted', current: false }), id: '66666666-6666-4666-8666-666666666667', results: [other(0, 'drugold', 'shown', null, 'Old text.')] };
  auth.apiFetch.mockImplementation(async () => page(withdrawn as never, evaluation));
  show();
  expect(await screen.findByText('Z normal-low.')).toBeVisible();
  expect(screen.queryByText('Old text.')).not.toBeInTheDocument();
  const closed = screen.getByRole('button', { name: 'drugold: not current, Recommendation' });
  expect(closed).toHaveAttribute('aria-expanded', 'false');
  // A row is a control: it keeps the 44px target (jsdom lays nothing out, so this checks the utility; no hosted browser suite measures a stored result).
  expect(closed).toHaveClass('min-h-control');
});

// Specs/019 adopted (specs/038): the open result's summary is the region whose display is measured. Display only, and only where the
// API records it: not in the synthetic staging, and not for a result whose wording is folded.
it('measures the display of the open current result, named by its drug', async () => {
  show();
  expect(await screen.findByRole('region', { name: 'Recommendation summary for drugz' })).toContainElement(screen.getByText('Z normal-low.'));
});

it('measures nothing in the synthetic staging, where the API does not record it', async () => {
  vi.stubEnv('VITE_SYNTHETIC_ASSESSMENT', 'true');
  show();
  expect(await screen.findByText('Z normal-low.')).toBeVisible();
  expect(screen.queryByRole('region', { name: /^Recommendation summary/ })).not.toBeInTheDocument();
});

it('measures nothing for a result that is not current: its wording is folded, so it was not displayed', async () => {
  auth.apiFetch.mockImplementation(async () => page(variant({ state: 'retracted', current: false })));
  show();
  fireEvent.click(await screen.findByRole('button', { name: 'drugz: not current, Recommendation' }));
  expect(screen.getByText('This is the evidence as it was stored with this earlier result.')).toBeVisible();
  expect(screen.queryByRole('region', { name: /^Recommendation summary/ })).not.toBeInTheDocument();
});

it('opens the result a link named, when it is on the page read', async () => {
  const two = { ...evaluation, results: [other(0, 'drugfirst', 'shown', null, 'First text.'), other(1, 'drugsecond', 'shown', null, 'Second text.')] };
  auth.apiFetch.mockImplementation(async () => page(two as never));
  render(<ResultsList patientId={patientId} followupBusy={false} onFollowup={() => undefined} initialResultId={two.results[1]!.id} />);
  expect(await screen.findByText('Second text.')).toBeVisible();
  expect(screen.queryByText('First text.')).not.toBeInTheDocument();
});

it('an assessment on hold says so with each result, and its decision history stays one click away', async () => {
  const heldEvaluation = {
    ...evaluation,
    disposition: 'held',
    holdCode: 'gene-absent',
    hold: { message: 'A needed gene result is missing.', reviewerAction: 'Ask the laboratory for it.' },
  };
  expect(() => evaluationSummaryDtoSchema.parse(heldEvaluation)).not.toThrow();
  auth.apiFetch.mockImplementation(async () => page(heldEvaluation as never));
  show();
  expect(await screen.findByText('Held: A needed gene result is missing. Ask the laboratory for it.')).toBeVisible();
  expect(screen.getByText('This assessment is on hold, so no decision can be recorded on it.')).toBeVisible();
  expect(screen.queryByRole('button', PANEL)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Decision history' }));
  expect(screen.getByRole('button', PANEL)).toBeVisible();
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
  // It is never opened for the reader, and its row says it is not current.
  expect(screen.queryByText('Z normal-low.')).not.toBeInTheDocument();
  expect(screen.getByText('Not current · Recommendation')).toBeVisible();
  openRow('drugz', 'not current, Recommendation');
  expect(screen.getByText('Z normal-low.')).not.toBeVisible();
  // Its evidence is labelled as what was stored then, and no decision can be recorded on it: only its history is offered.
  expect(screen.getByText('This is the evidence as it was stored with this earlier result.')).toBeVisible();
  expect(screen.getByText('This is not the current result, so no new decision can be recorded on it.')).toBeVisible();
  expect(screen.queryByRole('button', PANEL)).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Decision history' })).toBeVisible();
  fireEvent.click(screen.getByText('Show the text anyway'));
  expect(screen.getByText('Z normal-low.')).toBeVisible();
  expect(screen.queryByText('Current evaluation')).not.toBeInTheDocument();
});

it('a current result made with other guidelines is a caution: the wording stays readable', async () => {
  const changed = { ...evaluation, advisory: { ...evaluation.advisory, knowledge: { evaluatedWith: 'set', loadedNow: 'next', status: 'changed' } } };
  expect(() => evaluationSummaryDtoSchema.parse(changed)).not.toThrow();
  auth.apiFetch.mockImplementation(async () => page(changed));
  show();
  expect(await screen.findByText('The guidelines have changed since this result was made. A pharmacist must check whether it still applies.')).toBeVisible();
  expect(screen.getByText('Z normal-low.')).toBeVisible();
  expect(screen.queryByText('Show the text anyway')).not.toBeInTheDocument();
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
  fireEvent.click(await screen.findByRole('button', PANEL));
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
