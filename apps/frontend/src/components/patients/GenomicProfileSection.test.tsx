import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { REASON_MESSAGES, REVIEWER_ACTIONS } from '@telesphoros/cpic-schema/vocabulary';
import { GLOSSARY_EN } from '@telesphoros/help-content';
import { genomicProfileDtoSchema, type CandidateNotice, type ContextNotice, type GenomicProfileDto } from '@telesphoros/shared-types';
import { readGenomicProfile } from '@/lib/genomicProfile';
import { SIGNED_ASSESSMENT_SCOPE, SIGNED_KNOWLEDGE_LABEL } from '@/components/SignedKnowledgeLabel';
import { CANDIDATE_WORDS, DECISION_WORDS, GLOSSARY_WORDS, NOT_SAFE_SENTENCE, NOTICE_WORDS } from '@/lib/genomicProfileWords';
import { RecordingHeldContext } from '@/lib/patientIdentity';
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
  render(<GenomicProfileSection patientId={PATIENT} />, { wrapper: MemoryRouter });
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
  expect(within(row('clopidogrel')).queryByRole('button', { name: 'Why, and the evidence' })).not.toBeInTheDocument();
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
  render(<GenomicProfileSection patientId={PATIENT} />, { wrapper: MemoryRouter });
  expect(await screen.findAllByText('No current medications are recorded for this patient.')).toHaveLength(2);
});

it('answers in place when the environment does not serve the profile (503)', async () => {
  auth.apiFetch.mockImplementation(async () => json({}, 503));
  render(<GenomicProfileSection patientId={PATIENT} />, { wrapper: MemoryRouter });
  expect(await screen.findByText('The genomic profile is not available in this environment.')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('answers in place when the read fails, with a retry that reads again', async () => {
  auth.apiFetch.mockImplementationOnce(async () => json({}, 500));
  render(<GenomicProfileSection patientId={PATIENT} />, { wrapper: MemoryRouter });
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not read the genomic profile.');
  fireEvent.click(screen.getByRole('button', { name: 'Retry the genomic profile' }));
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

// Spec 045 slice N3. An invented modifier list: GENEA is not a real gene, and these drugs are not listed against anything by any real source.
const modifier = (
  medication: ContextNotice['medication'],
  effect: ContextNotice['effect'],
  strength: ContextNotice['strength'],
  row: string | null = '4',
  sourceUrl = 'https://synthetic.invalid/modifiers',
): ContextNotice => ({
  kind: 'gene-modifier',
  gene: 'GENEA',
  medication,
  effect,
  strength,
  source: { listId: 'syn-modifiers', source: 'Synthetic modifier table', sourceVersion: '2026-01', sourceUrl, table: 'Table S1', row },
});
const sertralineLowers = modifier({ rxcui: SERTRALINE, name: 'sertraline', startRecorded: true }, 'inhibitor', 'strong');
const simvastatinRaises = modifier({ rxcui: SIMVASTATIN, name: 'simvastatin', startRecorded: false }, 'inducer', 'moderate', null);
const withNotices = (notices: ContextNotice[] = [sertralineLowers, simvastatinRaises]): GenomicProfileDto => ({
  ...profile,
  modifierLists: { loaded: true },
  genes: profile.genes.map((gene) => (gene.gene === 'GENEA' ? { ...gene, contextNotices: [sertralineLowers] } : gene)),
  medications: profile.medications.map((check) => (check.rxcui === SIMVASTATIN ? { ...check, contextNotices: notices } : check)),
});
const sertralineOnRow = `Sertraline, which this patient takes, strongly lowers GENEA activity. ${NOTICE_WORDS.rowEnd}`;
const simvastatinOnRow = `Simvastatin itself moderately raises GENEA activity. ${NOTICE_WORDS.startNotRecorded} ${NOTICE_WORDS.rowEnd}`;
const sertralineOnCard = `Sertraline, which this patient takes, strongly lowers GENEA activity. ${NOTICE_WORDS.cardEnd}`;
const geneCard = (gene: string) => within(screen.getByRole('heading', { name: gene }).closest('li')!);

it('the N3 fixture is a valid profile response', () => {
  expect(() => genomicProfileDtoSchema.parse(withNotices())).not.toThrow();
});

it('says on the row, in everyday words and in the order sent, when a medication this patient takes can change the gene the guidance rests on', async () => {
  serve(withNotices());
  await show();
  const simvastatin = within(row('simvastatin'));
  expect(simvastatin.getByText(NOTICE_WORDS.lead)).toBeInTheDocument();
  expect(simvastatin.getByText(sertralineOnRow)).toBeInTheDocument();
  // the checked drug as its own modifier, with no start recorded
  expect(simvastatin.getByText(simvastatinOnRow)).toBeInTheDocument();
  const text = row('simvastatin').textContent!;
  expect(text.indexOf(sertralineOnRow)).toBeLessThan(text.indexOf(simvastatinOnRow));
  // shown without opening anything, after the quoted recommendation
  expect(simvastatin.getByRole('button', { name: 'Why, and the evidence' })).toHaveAttribute('aria-expanded', 'false');
  expect(text.indexOf('[Synthetic recommendation text]')).toBeLessThan(text.indexOf(NOTICE_WORDS.lead));
  // a row the server sent no notice for says nothing about modifiers
  expect(within(row('sertraline')).queryByText(NOTICE_WORDS.lead)).not.toBeInTheDocument();
  expect(within(row('clopidogrel')).queryByText(NOTICE_WORDS.lead)).not.toBeInTheDocument();
});

it("says it on the gene's card too, with the source on the line under it", async () => {
  serve(withNotices());
  await show();
  const card = geneCard('GENEA');
  expect(card.getByText(NOTICE_WORDS.lead)).toBeInTheDocument();
  expect(card.getByText(sertralineOnCard)).toBeInTheDocument();
  expect(card.getByText('Source: Synthetic modifier table, version 2026-01, Table S1, row 4.')).toBeInTheDocument();
  expect(geneCard('GENEB').queryByText(NOTICE_WORDS.lead)).not.toBeInTheDocument();
});

it("puts the source's own terms and where the list says it under the evidence, one step away (PN-7)", async () => {
  serve(withNotices());
  await show();
  const simvastatin = within(row('simvastatin'));
  expect(simvastatin.queryByText('Sertraline: listed as a strong inhibitor of GENEA.')).not.toBeInTheDocument();
  await userEvent.click(simvastatin.getByRole('button', { name: 'Why, and the evidence' }));
  expect(simvastatin.getByRole('heading', { name: NOTICE_WORDS.evidenceHeading })).toBeInTheDocument();
  expect(simvastatin.getByText('Sertraline: listed as a strong inhibitor of GENEA.')).toBeInTheDocument();
  expect(simvastatin.getByText('Simvastatin: listed as a moderate inducer of GENEA.')).toBeInTheDocument();
  expect(simvastatin.getByText('Source: Synthetic modifier table, version 2026-01, Table S1, row 4.')).toBeInTheDocument();
  // a null row is left out, not printed as "row null"
  expect(simvastatin.getByText('Source: Synthetic modifier table, version 2026-01, Table S1.')).toBeInTheDocument();
  const links = simvastatin.getAllByRole('link', { name: NOTICE_WORDS.openSource });
  expect(links).toHaveLength(2);
  expect(links[0]).toHaveAttribute('href', 'https://synthetic.invalid/modifiers');
});

it('links a source only over https, and still names it otherwise', async () => {
  serve(withNotices([modifier({ rxcui: SERTRALINE, name: 'sertraline', startRecorded: true }, 'inhibitor', 'strong', '4', 'javascript:alert(1)')]));
  await show();
  const simvastatin = within(row('simvastatin'));
  await userEvent.click(simvastatin.getByRole('button', { name: 'Why, and the evidence' }));
  expect(simvastatin.getByText('Source: Synthetic modifier table, version 2026-01, Table S1, row 4.')).toBeInTheDocument();
  expect(simvastatin.queryByRole('link', { name: NOTICE_WORDS.openSource })).not.toBeInTheDocument();
});

it('says the same in the drug checked before prescribing', async () => {
  auth.apiFetch.mockImplementation(async (path: string) => {
    const rxcui = new URL(path, 'http://synthetic').searchParams.get('rxcui');
    if (rxcui === null) return json(profile);
    return json({ ...profile, modifierLists: { loaded: true }, check: { ...reviewCheck, rxcui, name: null, contextNotices: [sertralineLowers] } });
  });
  await show();
  const check = within(screen.getByRole('heading', { name: 'Check a drug before prescribing' }).parentElement!);
  await userEvent.type(check.getByRole('combobox', { name: 'Drug' }), 'zocor');
  await userEvent.click(await check.findByRole('option', { name: /Zocor/ }));
  const answer = within(await check.findByRole('article', { name: 'simvastatin' }));
  expect(answer.getByText(sertralineOnRow)).toBeInTheDocument();
});

it('always says, under the medications heading, what the check covers or that it is not running yet (N3-D2, PN-6)', async () => {
  serve(withNotices());
  await show();
  expect(screen.getByText(NOTICE_WORDS.coverageLoaded)).toBeInTheDocument();
  expect(screen.queryByText(NOTICE_WORDS.coverageNotLoaded)).not.toBeInTheDocument();
  cleanup();
  serve({ ...profile, modifierLists: { loaded: false } });
  await show();
  expect(screen.getByText(NOTICE_WORDS.coverageNotLoaded)).toBeInTheDocument();
  cleanup();
  // an API that sends no modifierLists at all is not checking either
  serve(profile);
  await show();
  expect(screen.getByText(NOTICE_WORDS.coverageNotLoaded)).toBeInTheDocument();
  expect(screen.queryByText(NOTICE_WORDS.coverageLoaded)).not.toBeInTheDocument();
});

it('opens and closes "About this check" from the ⓘ', async () => {
  await show();
  expect(screen.queryByText(NOTICE_WORDS.about)).not.toBeInTheDocument();
  const about = screen.getByRole('button', { name: NOTICE_WORDS.aboutLabel });
  await userEvent.click(about);
  expect(about).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByText(NOTICE_WORDS.about)).toBeInTheDocument();
  await userEvent.click(about);
  expect(screen.queryByText(NOTICE_WORDS.about)).not.toBeInTheDocument();
});

it('changes nothing else on the screen: without the notice texts, the page reads exactly as the same profile without notices (PN-4)', async () => {
  serve(withNotices());
  await show();
  const withText = document.body.textContent!;
  cleanup();
  serve({ ...withNotices(), genes: profile.genes, medications: profile.medications });
  await show();
  const withoutText = document.body.textContent!;
  const noticeTexts = [
    NOTICE_WORDS.lead,
    GLOSSARY_WORDS.phenoconversion,
    sertralineOnRow,
    simvastatinOnRow,
    sertralineOnCard,
    'Source: Synthetic modifier table, version 2026-01, Table S1, row 4.',
  ];
  const stripped = noticeTexts.reduce((text, notice) => text.split(notice).join(''), withText);
  expect(stripped).toBe(withoutText);
  // control: the notices were there to strip
  expect(withText).not.toBe(withoutText);
});

it('never reassures with or without notices: no text says safe, no interaction, not affected or none (PN-5)', async () => {
  for (const body of [withNotices(), { ...profile, modifierLists: { loaded: true } }, { ...profile, modifierLists: { loaded: false } }]) {
    serve(body);
    await show();
    await userEvent.click(screen.getByRole('button', { name: NOTICE_WORDS.aboutLabel }));
    for (const button of screen.getAllByRole('button', { name: 'Why, and the evidence' })) await userEvent.click(button);
    const text = document.body.textContent!.split(NOT_SAFE_SENTENCE).join(' ');
    expect(text).not.toMatch(/\bsafe\b|no interaction|not affected|\bnone\b/i);
    cleanup();
  }
});

// Spec 044 slice B part 2: the glossary. Its entries are the draft ones in packages/help-content (B2-D2); the fixture's genes stay invented.
const entryOf = (id: string) => GLOSSARY_EN.find((item) => item.id === id)!;
const drawer = () => within(document.getElementById('genomic-glossary')!);
const withGlossaryPhenotype: GenomicProfileDto = {
  ...profile,
  genes: profile.genes.map((gene) => (gene.gene === 'GENEA' ? { ...gene, sources: [source(EVALUATION, 'Poor Metabolizer')] } : gene)),
};

it('opens a word on the row in the glossary drawer, says the entry is a draft, and returns focus to the word when closed', async () => {
  await show();
  const word = within(row('simvastatin')).getByRole('button', { name: 'Guidance to review' });
  // the drawer's text is in the page only while it is open
  expect(screen.queryByText(entryOf('guidance-to-review').body)).not.toBeInTheDocument();
  await userEvent.click(word);
  expect(drawer().getByText(entryOf('guidance-to-review').body)).toBeInTheDocument();
  expect(drawer().getByText(GLOSSARY_WORDS.draft)).toBeInTheDocument();
  await userEvent.click(drawer().getByRole('button', { name: GLOSSARY_WORDS.close }));
  expect(screen.queryByText(entryOf('guidance-to-review').body)).not.toBeInTheDocument();
  expect(word).toHaveFocus();
});

it("opens the gene's value from the row's because-line and from its card, and the sentence still reads whole", async () => {
  serve(withGlossaryPhenotype);
  await show();
  const value = within(row('simvastatin')).getByRole('button', { name: 'Poor Metabolizer' });
  expect(value.closest('p')).toHaveTextContent("Because GENEA is Poor Metabolizer in this patient's report.");
  expect(geneCard('GENEA').getByRole('button', { name: 'Poor Metabolizer' })).toBeInTheDocument();
  await userEvent.click(value);
  expect(drawer().getByText(entryOf('poor-metabolizer').body)).toBeInTheDocument();
});

it('leaves a word with no entry as plain text, guessing nothing', async () => {
  await show();
  const simvastatin = within(row('simvastatin'));
  expect(simvastatin.queryByRole('button', { name: 'Synthetic Poor' })).not.toBeInTheDocument();
  expect(simvastatin.getByText("Because GENEA is Synthetic Poor in this patient's report.")).toBeInTheDocument();
  expect(geneCard('GENEA').queryByRole('button', { name: 'Synthetic Poor' })).not.toBeInTheDocument();
});

it('lists every term from the ⓘ, and moves between an entry and the list inside the drawer', async () => {
  await show();
  await userEvent.click(screen.getByRole('button', { name: GLOSSARY_WORDS.listTitle }));
  for (const item of GLOSSARY_EN) expect(drawer().getByRole('button', { name: item.term })).toBeInTheDocument();
  await userEvent.click(drawer().getByRole('button', { name: 'Diplotype' }));
  expect(drawer().getByText(entryOf('diplotype').body)).toBeInTheDocument();
  expect(drawer().getByRole('heading', { name: 'Diplotype' })).toHaveFocus();
  await userEvent.click(drawer().getByRole('button', { name: GLOSSARY_WORDS.allTerms }));
  expect(drawer().getByRole('button', { name: 'Phenoconversion' })).toBeInTheDocument();
  expect(drawer().queryByText(entryOf('diplotype').body)).not.toBeInTheDocument();
});

it('opens Phenoconversion from the notice', async () => {
  serve(withNotices());
  await show();
  await userEvent.click(within(row('simvastatin')).getByRole('button', { name: GLOSSARY_WORDS.phenoconversion }));
  expect(drawer().getByText(entryOf('phenoconversion').body)).toBeInTheDocument();
});

// Spec 044 slice B part 2b: "Record a decision" (D9, B2-D4) and K2c's signed-knowledge label (B2-D5).
afterEach(() => vi.unstubAllEnvs());
const signedResults = reviewCheck.results.map((item) => ({ ...item, scope: SIGNED_ASSESSMENT_SCOPE }));
const withSignedSimvastatin: GenomicProfileDto = {
  ...profile,
  medications: profile.medications.map((check) => (check.rxcui === SIMVASTATIN ? { ...check, results: signedResults } : check)),
};

it('offers "Record a decision" under the evidence, as a link to the result in the results list where decisions are on', async () => {
  await show();
  const simvastatin = within(row('simvastatin'));
  expect(simvastatin.queryByRole('link', { name: DECISION_WORDS.recordHere })).not.toBeInTheDocument();
  await userEvent.click(simvastatin.getByRole('button', { name: 'Why, and the evidence' }));
  expect(simvastatin.getByRole('link', { name: DECISION_WORDS.recordHere })).toHaveAttribute('href', '/?result=55555555-5555-4555-8555-555555555551');
  // nothing is written from the profile
  const calls = auth.apiFetch.mock.calls as [string, RequestInit | undefined][];
  expect(calls.every(([, init]) => init?.method === undefined || init.method === 'GET')).toBe(true);
});

it('shows it disabled in the synthetic staging, with its sentence beside it in plain text', async () => {
  vi.stubEnv('VITE_SYNTHETIC_ASSESSMENT', 'true');
  await show();
  const simvastatin = within(row('simvastatin'));
  await userEvent.click(simvastatin.getByRole('button', { name: 'Why, and the evidence' }));
  expect(simvastatin.getByRole('button', { name: DECISION_WORDS.record })).toBeDisabled();
  expect(simvastatin.getByText(DECISION_WORDS.off)).toBeInTheDocument();
  expect(simvastatin.queryByRole('link', { name: DECISION_WORDS.recordHere })).not.toBeInTheDocument();
});

it("says once, under the drug's name, when a result on the row was made with the signed, real knowledge (K2c)", async () => {
  serve(withSignedSimvastatin);
  await show();
  expect(within(row('simvastatin')).getAllByText(SIGNED_KNOWLEDGE_LABEL)).toHaveLength(1);
  // a row whose results carry no scope, or another one, says nothing of the kind
  expect(within(row('sertraline')).queryByText(SIGNED_KNOWLEDGE_LABEL)).not.toBeInTheDocument();
  cleanup();
  serve({ ...withSignedSimvastatin, medications: [{ ...reviewCheck, results: reviewCheck.results.map((item) => ({ ...item, scope: 'synthetic-patient' })) }] });
  render(<GenomicProfileSection patientId={PATIENT} />, { wrapper: MemoryRouter });
  expect(await screen.findByRole('article', { name: 'simvastatin' })).toBeInTheDocument();
  expect(screen.queryByText(SIGNED_KNOWLEDGE_LABEL)).not.toBeInTheDocument();
});

it('the signed fixture is a valid profile response', () => {
  expect(() => genomicProfileDtoSchema.parse(withSignedSimvastatin)).not.toThrow();
});

// docs/design/plans/patient-page-identity-outage.md, B-D3: while the patient's identity could not be read, the link to the held results is not offered.
it('does not offer "Record a decision" while the patient page holds recording, and still shows the evidence', async () => {
  render(
    <RecordingHeldContext.Provider value={true}>
      <GenomicProfileSection patientId={PATIENT} />
    </RecordingHeldContext.Provider>,
    { wrapper: MemoryRouter },
  );
  await screen.findByText('1 of 4 current medications has guidance to review');
  const simvastatin = within(row('simvastatin'));
  await userEvent.click(simvastatin.getByRole('button', { name: 'Why, and the evidence' }));
  expect(simvastatin.getAllByRole('heading', { name: 'The evidence' }).length).toBeGreaterThan(0);
  expect(simvastatin.queryByRole('link', { name: DECISION_WORDS.recordHere })).not.toBeInTheDocument();
  expect(simvastatin.queryByRole('button', { name: DECISION_WORDS.record })).not.toBeInTheDocument();
});

// Spec 045 slice N4: the drug being checked as a modifier. An invented list; no drug here is listed against anything real.
const candidateSource: CandidateNotice['source'] = {
  listId: 'syn-modifiers',
  source: 'Synthetic modifier table',
  sourceVersion: '2026-01',
  sourceUrl: 'https://synthetic.invalid/modifiers',
  table: 'Table S2',
  row: null,
};
function candidate(affected: CandidateNotice['affected'], effect: CandidateNotice['effect'] = 'inhibitor', strength: CandidateNotice['strength'] = 'strong'): CandidateNotice {
  return { kind: 'candidate-modifier', gene: 'GENEA', effect, strength, affected, source: candidateSource };
}
const sertralineAffected = { rxcui: SERTRALINE, name: 'sertraline', self: false };
const clopidogrelAffected = { rxcui: CLOPIDOGREL, name: 'clopidogrel', self: false };
const selfAffected = { rxcui: SIMVASTATIN, name: null, self: true };
const checkedWith = (notices: CandidateNotice[]): GenomicProfileDto => ({
  ...profile,
  modifierLists: { loaded: true },
  check: { ...reviewCheck, name: null, candidateNotices: notices },
});
/** Checks simvastatin (by its brand) before prescribing, with the given candidate notices on the answer, and returns its row. */
const checkDrug = async (notices: CandidateNotice[]) => {
  auth.apiFetch.mockImplementation(async (path: string) => {
    const rxcui = new URL(path, 'http://synthetic').searchParams.get('rxcui');
    return json(rxcui === null ? profile : checkedWith(notices));
  });
  await show();
  const check = within(screen.getByRole('heading', { name: 'Check a drug before prescribing' }).parentElement!);
  await userEvent.type(check.getByRole('combobox', { name: 'Drug' }), 'zocor');
  await userEvent.click(await check.findByRole('option', { name: /Zocor/ }));
  return within(await check.findByRole('article', { name: 'simvastatin' }));
};
const othersEnd = 'which this patient takes, is based on GENEA and does not take this into account.';

it('the N4 fixture is a valid profile response', () => {
  expect(() => genomicProfileDtoSchema.parse(checkedWith([candidate([sertralineAffected, clopidogrelAffected, selfAffected])]))).not.toThrow();
});

it('says on the drug being checked which current guidance rests on a gene it changes, in everyday words', async () => {
  const answer = await checkDrug([candidate([sertralineAffected])]);
  expect(answer.getByText(CANDIDATE_WORDS.lead)).toBeInTheDocument();
  expect(answer.getByText(`Simvastatin strongly lowers GENEA activity. The guidance for sertraline, ${othersEnd}`)).toBeInTheDocument();
  // the current medications' own rows are unchanged (N4-D2)
  for (const name of ['sertraline', 'clopidogrel']) expect(within(row(name)).queryByText(CANDIDATE_WORDS.lead)).not.toBeInTheDocument();
});

it("names several current medications in the order sent, and says when the drug's own guidance rests on the gene too", async () => {
  const answer = await checkDrug([candidate([sertralineAffected, clopidogrelAffected, selfAffected])]);
  const several = `Simvastatin strongly lowers GENEA activity. The guidance for sertraline and clopidogrel, ${othersEnd}`;
  const selfToo = 'Its own guidance above is based on GENEA as well, and does not take this into account either.';
  expect(answer.getByText(`${several} ${selfToo}`)).toBeInTheDocument();
});

it('says "raises" and "moderately" for a moderate inducer, and speaks of the drug\'s own guidance alone when only it is affected', async () => {
  const answer = await checkDrug([candidate([selfAffected], 'inducer', 'moderate')]);
  expect(answer.getByText('Simvastatin moderately raises GENEA activity. Its own guidance above is based on GENEA and does not take this into account.')).toBeInTheDocument();
});

it("puts the source's own terms and where the list says it under the drug's evidence (PN-7)", async () => {
  const answer = await checkDrug([candidate([sertralineAffected])]);
  expect(answer.queryByText('Simvastatin: listed as a strong inhibitor of GENEA.')).not.toBeInTheDocument();
  await userEvent.click(answer.getByRole('button', { name: 'Why, and the evidence' }));
  expect(answer.getByText('Simvastatin: listed as a strong inhibitor of GENEA.')).toBeInTheDocument();
  expect(answer.getByText('Source: Synthetic modifier table, version 2026-01, Table S2.')).toBeInTheDocument();
});

it('says nothing of the kind when the check carries no candidate notice', async () => {
  const answer = await checkDrug([]);
  expect(answer.queryByText(CANDIDATE_WORDS.lead)).not.toBeInTheDocument();
});

it('never reassures in the N4 notice (PN-5)', async () => {
  const answer = await checkDrug([candidate([sertralineAffected, selfAffected])]);
  await userEvent.click(answer.getByRole('button', { name: 'Why, and the evidence' }));
  const text = document.body.textContent!.split(NOT_SAFE_SENTENCE).join(' ');
  expect(text).not.toMatch(/\bsafe\b|no interaction|not affected|\bnone\b/i);
});
