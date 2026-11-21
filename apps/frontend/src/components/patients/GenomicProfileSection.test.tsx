import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { REASON_MESSAGES, REVIEWER_ACTIONS } from '@telesphoros/cpic-schema/vocabulary';
import { genomicProfileDtoSchema, type GenomicProfileDto } from '@telesphoros/shared-types';
import { readGenomicProfile } from '@/lib/genomicProfile';
import { NOT_SAFE_SENTENCE } from '@/lib/genomicProfileWords';
import { GenomicProfileSection } from './GenomicProfileSection';

const auth = vi.hoisted(() => ({ apiFetch: vi.fn(), roles: ['clinician'] as string[] }));
vi.mock('@/auth/AuthProvider', async (original) => ({ ...(await original<typeof import('@/auth/AuthProvider')>()), useAuth: () => auth }));

// Synthetic patient, invented genes and phenotypes, placeholder wording: nothing here is CPIC content. The drug ids are the bundled list's.
const PATIENT = '22222222-2222-4222-8222-222222222222';
const EVALUATION = '66666666-6666-4666-8666-666666666666';
const OTHER_EVALUATION = '77777777-7777-4777-8777-777777777777';
const REPORT = '11111111-1111-4111-8111-111111111111';
const SIMVASTATIN = '36567';
const SERTRALINE = '36437';
const CLOPIDOGREL = '32968';
const COMBINATION = '1945211';
const HELD_REASON = 'duplicate-gene-conflict';
const source = (evaluationId: string, phenotype: string | null) => ({
  evaluationId,
  reportId: REPORT,
  evaluatedAt: '2026-11-04T00:00:00Z',
  state: phenotype ? 'canonical' : 'unsupported-source',
  phenotype,
  diplotype: phenotype ? '*2/*2' : null,
  activityScore: null,
  reasonCode: null,
});
const result = (id: string, outcome: string, genes: string[], extra: Partial<GenomicProfileDto['medications'][number]['results'][number]> = {}) => ({
  evaluationId: EVALUATION,
  resultId: id,
  outcome,
  reasonCode: null,
  strength: null,
  recommendationText: null,
  implication: null,
  citation: null,
  genes,
  ...extra,
});
const reviewCheck = {
  rxcui: SIMVASTATIN,
  name: 'simvastatin',
  word: 'review' as const,
  knowledgeChanged: true,
  conflict: false,
  results: [
    result('55555555-5555-4555-8555-555555555551', 'shown', ['GENEA'], {
      strength: 'Strong',
      recommendationText: '[Synthetic recommendation text]',
      citation: { guidelineId: 'syn-guideline', guidelineVersion: '1', locator: { table: 'Table 2', row: 'Synthetic Poor' }, verification: 'verified' },
    }),
  ],
};
const profile: GenomicProfileDto = {
  patientId: PATIENT,
  clinicalUse: 'not-approved',
  capped: false,
  genes: [
    { gene: 'GENEA', status: 'resolved', sources: [source(EVALUATION, 'Synthetic Poor')] },
    { gene: 'GENEB', status: 'conflict', sources: [source(EVALUATION, 'Synthetic Normal'), source(OTHER_EVALUATION, 'Synthetic Poor')] },
  ],
  awaitingLinkReview: [{ evaluationId: '88888888-8888-4888-8888-888888888888', reportId: REPORT }],
  medications: [
    reviewCheck,
    {
      rxcui: SERTRALINE,
      name: 'sertraline',
      word: 'held',
      knowledgeChanged: false,
      conflict: true,
      results: [result('55555555-5555-4555-8555-555555555552', 'held', ['GENEB', 'GENEC'], { reasonCode: HELD_REASON })],
    },
    { rxcui: CLOPIDOGREL, name: 'clopidogrel', word: 'no-guideline-loaded', knowledgeChanged: false, conflict: false, results: [] },
    { rxcui: COMBINATION, name: '5-hydroxytryptophan / melatonin', word: 'no-guideline-loaded', knowledgeChanged: false, conflict: false, results: [] },
  ],
  check: null,
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const serve = (body: GenomicProfileDto) => {
  auth.apiFetch.mockImplementation(async (path: string) => {
    const rxcui = new URL(path, 'http://synthetic').searchParams.get('rxcui');
    if (rxcui === null) return json(body);
    return json({ ...body, check: { ...reviewCheck, rxcui, name: null } });
  });
};
const show = async () => {
  render(<GenomicProfileSection patientId={PATIENT} />);
  return screen.findByText('1 of 4 current medications has guidance to review');
};
const row = (name: string) => screen.getByRole('article', { name });

beforeEach(() => {
  auth.apiFetch.mockReset();
  serve(profile);
});

it('the fixture is a valid profile response, so the cases below test the screen and not the fixture', () => {
  expect(() => genomicProfileDtoSchema.parse(profile)).not.toThrow();
});

it('leads with a summary that counts only guidance to review, and the notice for reports waiting for their patient link', async () => {
  await show();
  expect(screen.getByRole('status')).toHaveTextContent('1 report is waiting for review. A second person has not yet confirmed that it belongs to this patient');
});

it('gives each medication its word and the sentence the word always carries (G3 draft)', async () => {
  await show();
  expect(within(row('simvastatin')).getByText('Guidance to review')).toBeInTheDocument();
  const held = within(row('sertraline'));
  expect(held.getByText('Held')).toBeInTheDocument();
  expect(held.getByText(`${REASON_MESSAGES[HELD_REASON]} ${REVIEWER_ACTIONS[HELD_REASON]}`)).toBeInTheDocument();
  const none = within(row('clopidogrel'));
  expect(none.getByText('No guideline loaded')).toBeInTheDocument();
  expect(none.getByText('The loaded guidelines do not cover this drug. This does not mean it is safe.')).toBeInTheDocument();
});

it('quotes the recommendation with its strength and the gene it rests on (layer 1)', async () => {
  await show();
  const simvastatin = within(row('simvastatin'));
  expect(simvastatin.getByText('[Synthetic recommendation text]').tagName).toBe('BLOCKQUOTE');
  expect(simvastatin.getByText('Strength: Strong')).toBeInTheDocument();
  expect(simvastatin.getByText("Because GENEA is Synthetic Poor in this patient's report.")).toBeInTheDocument();
  // a held result has no wording to quote
  expect(within(row('sertraline')).queryByRole('blockquote')).not.toBeInTheDocument();
});

it('says on the row when guidelines changed, when reports disagree, and when a product is a combination', async () => {
  await show();
  const changed = 'The guidelines have changed since this result was made. A pharmacist must check whether it still applies.';
  expect(within(row('simvastatin')).getByText(changed)).toBeInTheDocument();
  expect(within(row('sertraline')).queryByText(changed)).not.toBeInTheDocument();
  expect(within(row('sertraline')).getByText('Two reports disagree about GENEB. Both are shown under the evidence.')).toBeInTheDocument();
  const combination = 'Combination product: checked only as the combination. Its ingredients are not checked separately.';
  expect(within(row('5-hydroxytryptophan / melatonin')).getByText(combination)).toBeInTheDocument();
  expect(within(row('clopidogrel')).queryByText(combination)).not.toBeInTheDocument();
});

it('opens why and the evidence on request (layers 2 and 3)', async () => {
  await show();
  const simvastatin = within(row('simvastatin'));
  expect(simvastatin.queryByText('CPIC gives no separate implication for this result.')).not.toBeInTheDocument();
  await userEvent.click(simvastatin.getByRole('button', { name: 'Why, and the evidence' }));
  expect(simvastatin.getByRole('button', { name: 'Hide why and the evidence' })).toHaveAttribute('aria-expanded', 'true');
  expect(simvastatin.getByText('CPIC gives no separate implication for this result.')).toBeInTheDocument();
  expect(simvastatin.getByText('Table 2, Synthetic Poor')).toBeInTheDocument();
  expect(simvastatin.getByText('syn-guideline, version 1')).toBeInTheDocument();
  expect(simvastatin.getByText('Verified')).toBeInTheDocument();
  // a row with no matching result has nothing to open
  expect(within(row('clopidogrel')).queryByRole('button')).not.toBeInTheDocument();
});

it('shows one card per gene, and "Not tested" for a gene a guideline needs that no confirmed report includes', async () => {
  await show();
  expect(screen.getAllByText('Synthetic Poor').length).toBeGreaterThan(0);
  expect(screen.getByText('Two reports disagree. Both are shown under the evidence of each medication that uses this gene.')).toBeInTheDocument();
  const untested = screen.getByRole('heading', { name: 'GENEC' }).closest('li')!;
  expect(within(untested).getByText('Not tested')).toBeInTheDocument();
});

it('says when the profile does not include every report', async () => {
  serve({ ...profile, capped: true });
  await show();
  expect(screen.getByText('Not every report is included here. Open Reports for the rest.')).toBeInTheDocument();
});

it('says when no medication is recorded, without claiming anything else', async () => {
  serve({ ...profile, medications: [], awaitingLinkReview: [] });
  render(<GenomicProfileSection patientId={PATIENT} />);
  expect(await screen.findAllByText('No current medications are recorded for this patient.')).toHaveLength(2);
});

it('answers in place when the environment does not serve the profile (503)', async () => {
  auth.apiFetch.mockImplementation(async () => json({}, 503));
  render(<GenomicProfileSection patientId={PATIENT} />);
  expect(await screen.findByText('The genomic profile is not available in this environment.')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('answers in place when the read fails, with a retry that reads again', async () => {
  auth.apiFetch.mockImplementationOnce(async () => json({}, 500));
  render(<GenomicProfileSection patientId={PATIENT} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not read the genomic profile.');
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByText('1 of 4 current medications has guidance to review')).toBeInTheDocument();
});

it('checks a drug before prescribing by its RxNorm id, from a brand or an ingredient name, and saves nothing', async () => {
  await show();
  const check = within(screen.getByRole('heading', { name: 'Check a drug before prescribing' }).parentElement!);
  expect(check.getByText('Nothing is saved.')).toBeInTheDocument();
  await userEvent.type(check.getByRole('combobox', { name: 'Drug' }), 'zocor');
  await userEvent.click(await check.findByRole('option', { name: /Zocor/ }));
  expect(await check.findByRole('article', { name: 'simvastatin' })).toBeInTheDocument();
  const calls = auth.apiFetch.mock.calls as [string, RequestInit | undefined][];
  expect(calls.some(([path]) => path === `/api/v1/patients/${PATIENT}/genomic-profile?rxcui=${SIMVASTATIN}`)).toBe(true);
  // every request is a read
  expect(calls.every(([, init]) => init?.method === undefined || init.method === 'GET')).toBe(true);
});

it('never reassures: no rendered text says safe, no interaction, normal response or OK, except the sentence that says the opposite', async () => {
  await show();
  for (const button of screen.getAllByRole('button', { name: 'Why, and the evidence' })) await userEvent.click(button);
  const text = document.body.textContent!.split(NOT_SAFE_SENTENCE).join(' ');
  expect(text).not.toMatch(/\bsafe\b|no interaction|normal response|\bOK\b|all clear|no issues/i);
});

it('refuses a response for another patient, or a check for another drug, as a failure', async () => {
  auth.apiFetch.mockImplementation(async () => json({ ...profile, patientId: '33333333-3333-4333-8333-333333333333' }));
  await expect(readGenomicProfile(auth.apiFetch, PATIENT)).rejects.toThrow('Could not read the genomic profile.');
  auth.apiFetch.mockImplementation(async () => json({ ...profile, check: { ...reviewCheck, rxcui: SERTRALINE } }));
  await expect(readGenomicProfile(auth.apiFetch, PATIENT, SIMVASTATIN)).rejects.toThrow('Could not read the genomic profile.');
  // control
  serve(profile);
  await expect(readGenomicProfile(auth.apiFetch, PATIENT, SIMVASTATIN)).resolves.toMatchObject({ kind: 'loaded' });
});
