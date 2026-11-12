import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { expect, it } from 'vitest';
import { REASON_CODES, REASON_MESSAGES, REASON_OUTCOME } from '@telesphoros/cpic-schema/vocabulary';
import { evaluationDtoSchema, type EvaluationDto } from '@telesphoros/shared-types';
import { AssessmentResult } from './AssessmentResult';

type Result = EvaluationDto['results'][number];
const shown = (id: string, drug: string): Result => ({
  id,
  ordinal: 0,
  drug,
  genes: ['GENEA'],
  outcome: 'shown',
  reasonCode: null,
  strength: 'Strong',
  citation: { guidelineId: 'drug-genea' },
  recommendationText: `${drug} at the usual dose.`,
  implication: null,
  geneEvidence: null,
});
const notShown = (id: string, drug: string, outcome: string, reasonCode: string | null): Result => ({
  ...shown(id, drug),
  outcome,
  reasonCode,
  strength: null,
  citation: null,
  recommendationText: null,
});
const evaluation = (results: Result[]): EvaluationDto => ({
  id: '66666666-6666-4666-8666-666666666666',
  reportId: '11111111-1111-4111-8111-111111111111',
  patientId: '22222222-2222-4222-8222-222222222222',
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
  results: results.map((result, ordinal) => ({ ...result, ordinal })),
  geneStates: [{ gene: 'GENEA', state: 'canonical', phenotype: 'Poor Metabolizer', diplotype: '*2/*3', activityScore: '0.0', reasonCode: null }],
  geneInputs: [],
  corrections: [],
  current: true,
  advisory: { activeDisputes: 0, patientLink: 'verified', knowledge: { evaluatedWith: 'set', loadedNow: 'set', status: 'same' } },
  actionable: false,
  createdAt: '2026-11-04T00:00:00Z',
});
const ids = ['55555555-5555-4555-8555-555555555551', '55555555-5555-4555-8555-555555555552', '55555555-5555-4555-8555-555555555553'];
const show = (value: EvaluationDto) => {
  expect(() => evaluationDtoSchema.parse(value)).not.toThrow();
  return render(
    <MemoryRouter>
      <AssessmentResult evaluation={value} created />
    </MemoryRouter>,
  );
};

// Every reason code with the outcome it belongs to, and the plain words each is shown as. A new code fails here (and a new outcome fails to
// compile in resultStatus.ts) until it has wording.
const label: Record<string, string> = {
  held: 'On hold: needs review',
  abstained: 'Could not be evaluated',
  'no-published-recommendation': 'The guideline gives no recommendation for this case',
  'no-guideline': 'No guideline for this drug',
};
it.each(REASON_CODES.map((code) => [code, REASON_OUTCOME[code]] as const))('%s (%s): plain words, the raw codes only in provenance', (code, outcome) => {
  show(evaluation([notShown(ids[0]!, 'drugz', outcome, code)]));
  const section = screen.getByRole('region', { name: 'Assessment drugz' });
  expect(within(section).getByText(label[outcome]!)).toBeVisible();
  if (outcome === 'held' || outcome === 'abstained') expect(within(section).getByText(REASON_MESSAGES[code])).toBeVisible();
  expect(within(section).getByText(`Outcome code: ${outcome} · Reason code: ${code}`)).not.toBeVisible();
});

it('a shown result reads "Recommendation" with the phenotype it rests on', () => {
  show(evaluation([shown(ids[0]!, 'drugz')]));
  const section = screen.getByRole('region', { name: 'Assessment drugz' });
  expect(within(section).getByText('Recommendation')).toBeVisible();
  expect(within(section).getByText('GENEA: Poor Metabolizer')).toBeVisible();
  expect(within(section).getByText('drugz at the usual dose.')).toBeVisible();
  expect(within(section).getByText('GENEA diplotype *2/*3, activity score 0.0')).not.toBeVisible();
});

it('an outcome this screen does not know is never shown as a recommendation', () => {
  show(evaluation([{ ...shown(ids[0]!, 'drugz'), outcome: 'something-new' }]));
  const section = screen.getByRole('region', { name: 'Assessment drugz' });
  expect(within(section).getByText('Could not be evaluated')).toBeVisible();
  expect(within(section).queryByText('Recommendation')).not.toBeInTheDocument();
  expect(within(section).queryByText('drugz at the usual dose.')).not.toBeInTheDocument();
});

// Finishing is not a verdict (specs/038 D6). The line used to be green whenever every drug had a recommendation, whatever the
// recommendations said.
it('a completed assessment says so in the ordinary colour, never in green', () => {
  show(evaluation([shown(ids[0]!, 'drugz'), shown(ids[1]!, 'drugy')]));
  const line = screen.getByText('Assessment completed. All 2 drugs evaluated.');
  expect(line).not.toHaveClass('text-success');
  expect(line).not.toHaveClass('text-warning');
});

it('a restrictive recommendation after a completed assessment has no success colour anywhere near it', () => {
  const { container } = show(evaluation([{ ...shown(ids[0]!, 'drugz'), recommendationText: 'Avoid drugz. Use an alternative not metabolised by GENEA.' }]));
  expect(screen.getByText('Assessment completed. 1 drug evaluated.')).toBeVisible();
  expect(screen.getByText('Avoid drugz. Use an alternative not metabolised by GENEA.')).toBeVisible();
  expect(container.querySelector('.text-success')).toBeNull();
});

it('reads the stored citation as labelled lines, says which parts were not recorded, and keeps the stored form under technical provenance', () => {
  const citation = {
    guidelineId: 'syn-guideline-drugz',
    guidelineVersion: 'synthetic-3',
    sourceUrl: 'https://guidelines.example.test/drugz',
    locator: { table: 'Synthetic Table 2', row: 'Poor Metabolizer', column: null },
    verification: 'verified',
  };
  show(evaluation([{ ...shown(ids[0]!, 'drugz'), citation }]));
  const source = within(within(screen.getByRole('region', { name: 'Assessment drugz' })).getByLabelText('Source'));
  expect(source.getByText('syn-guideline-drugz · version synthetic-3')).toBeVisible();
  expect(source.getByText('table Synthetic Table 2, row Poor Metabolizer')).toBeVisible();
  expect(source.getByText('Verified')).toBeVisible();
  expect(source.getByText('Strong')).toBeVisible();
  const link = source.getByRole('link', { name: 'Open the source (new tab)' });
  expect(link).toHaveAttribute('href', 'https://guidelines.example.test/drugz');
  expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  // The stored form is still there, on demand, and nowhere else.
  expect(screen.getByText('Citation as stored:')).not.toBeVisible();
  expect(screen.getByText(/"guidelineId": "syn-guideline-drugz"/)).not.toBeVisible();
});

it('a citation stored without a version, a location or a verification state says so, and invents none', () => {
  show(evaluation([shown(ids[0]!, 'drugz')]));
  const source = within(screen.getByLabelText('Source'));
  expect(source.getByText('drug-genea · version not recorded')).toBeVisible();
  expect(source.getAllByText('not recorded')).toHaveLength(2);
  expect(source.queryByRole('link')).toBeNull();
});

it.each([
  ['unverified', 'Not verified'],
  ['disputed', 'Disputed'],
  ['some-later-state', 'Not recognised by this screen'],
])('a %s citation reads "%s" as a caution, never as verified', (verification, word) => {
  show(evaluation([{ ...shown(ids[0]!, 'drugz'), citation: { guidelineId: 'drug-genea', verification } }]));
  const source = within(screen.getByLabelText('Source'));
  expect(source.getByText(word)).toHaveClass('text-warning');
  expect(source.queryByText('Verified')).toBeNull();
});

it.each(['http://guidelines.example.test/drugz', 'javascript:alert(1)', 'not a url'])('offers no link for a source address that is not https (%s)', (sourceUrl) => {
  show(evaluation([{ ...shown(ids[0]!, 'drugz'), citation: { guidelineId: 'drug-genea', sourceUrl } }]));
  expect(within(screen.getByLabelText('Source')).queryByRole('link')).toBeNull();
});

it('an outcome with no wording shows no source, even if a citation came with it', () => {
  show(evaluation([{ ...notShown(ids[0]!, 'drugz', 'no-guideline', null), citation: { guidelineId: 'drug-genea' } }]));
  expect(screen.getByText('No guideline for this drug')).toBeVisible();
  expect(screen.queryByLabelText('Source')).toBeNull();
});

it('one drug without a recommendation turns the evaluation line to a warning', () => {
  show(evaluation([shown(ids[0]!, 'drugz'), notShown(ids[1]!, 'drugy', 'held', 'cell-disputed'), shown(ids[2]!, 'drugx')]));
  const line = screen.getByText('1 of 3 drugs has no recommendation.');
  expect(line).toHaveClass('text-warning');
  expect(line).not.toHaveClass('text-success');
  expect(screen.queryByText(/drugs evaluated\./)).not.toBeInTheDocument();
});

it('every drug on hold: no drug could be evaluated', () => {
  show(evaluation([notShown(ids[0]!, 'drugz', 'held', 'gene-absent'), notShown(ids[1]!, 'drugy', 'held', 'cell-disputed')]));
  expect(screen.getByText('No drug could be evaluated. 2 on hold.')).toHaveClass('text-warning');
});
