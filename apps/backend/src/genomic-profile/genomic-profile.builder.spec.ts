import { type EvaluationSummaryDto, GENOMIC_CHECK_WORDS, genomicProfileDtoSchema } from '@telesphoros/shared-types';
import { buildGenomicProfile, type ModifierLookup, type ProfileEvaluation, type ProfileMedication, type ProfileModifier } from './genomic-profile.builder';

// Spec 044 slice A, rules 1 to 6 of plan-slice-a.md. Every expectation is written by hand from the inputs beside it. Synthetic data only: the
// genes and drugs are invented (GENEA, GENEB) and the RxCUIs are numbers in the real form that name no drug in this test's meaning.

const PATIENT = '00000000-0000-4000-8000-0000000000a1';
let counter = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;

interface ResultSpec {
  outcome: string;
  rxcui: string | null;
  genes?: string[];
  drug?: string;
}
interface EvaluationSpec {
  link?: 'verified' | 'unverified' | 'rejected';
  current?: boolean;
  state?: 'active' | 'retracted' | 'superseded';
  knowledge?: 'same' | 'changed' | 'unknown';
  createdAt?: string;
  genes?: Array<{ gene: string; phenotype?: string | null; activityScore?: string | null; state?: string; reasonCode?: string | null }>;
  results?: ResultSpec[];
}

/** Only the fields the builder reads are meaningful; the rest are filled so the object has the DTO's shape. */
function evaluation(spec: EvaluationSpec): ProfileEvaluation {
  const id = uuid();
  const results = (spec.results ?? []).map((r, ordinal) => ({
    id: uuid(),
    ordinal,
    drug: r.drug ?? 'drugx',
    genes: r.genes ?? ['GENEA'],
    outcome: r.outcome,
    reasonCode: r.outcome === 'held' ? 'gene-absent' : null,
    strength: r.outcome === 'shown' ? 'Strong' : null,
    citation: r.outcome === 'shown' ? { guidelineId: 'syn-guideline' } : null,
    recommendationText: r.outcome === 'shown' ? 'Synthetic wording.' : null,
    implication: null,
    geneEvidence: null,
  }));
  const dto = {
    id,
    reportId: uuid(),
    patientId: PATIENT,
    current: spec.current ?? true,
    state: spec.state ?? 'active',
    createdAt: spec.createdAt ?? '2026-11-01T00:00:00.000Z',
    advisory: {
      activeDisputes: 0,
      patientLink: spec.link ?? 'verified',
      ...(spec.knowledge === undefined ? {} : { knowledge: { evaluatedWith: 'syn-set-a', loadedNow: 'syn-set-b', status: spec.knowledge } }),
    },
    geneStates: (spec.genes ?? []).map((g) => ({
      gene: g.gene,
      state: g.state ?? 'determined',
      phenotype: g.phenotype === undefined ? null : g.phenotype,
      diplotype: null,
      activityScore: g.activityScore ?? null,
      reasonCode: g.reasonCode ?? null,
    })),
    results,
  } as unknown as EvaluationSummaryDto;
  const rxcuis = new Map<string, string | null>((spec.results ?? []).map((r, i) => [results[i]!.id, r.rxcui]));
  return { evaluation: dto, drugRxcuiByResultId: rxcuis };
}

const medication = (rxcui: string, name = 'drug', over: Partial<ProfileMedication> = {}): ProfileMedication => ({ rxcui, name, status: 'active', current: true, ...over });
const build = (evaluations: ProfileEvaluation[], medications: ProfileMedication[] = [], checkRxcui?: string) =>
  buildGenomicProfile({ patientId: PATIENT, evaluations, medications, checkRxcui, capped: false });

describe('rule 1: only current, active evaluations with a verified patient link are used', () => {
  it('uses a verified evaluation, lists an unverified one apart, and drops a rejected, retracted or non-current one', () => {
    const verified = evaluation({ genes: [{ gene: 'GENEA', phenotype: 'Normal' }], results: [{ outcome: 'shown', rxcui: '111' }] });
    const unverified = evaluation({ link: 'unverified', genes: [{ gene: 'GENEB', phenotype: 'Poor' }], results: [{ outcome: 'shown', rxcui: '222' }] });
    const rejected = evaluation({ link: 'rejected', genes: [{ gene: 'GENEC', phenotype: 'Poor' }] });
    const retracted = evaluation({ state: 'retracted', genes: [{ gene: 'GENED', phenotype: 'Poor' }] });
    const old = evaluation({ current: false, genes: [{ gene: 'GENEE', phenotype: 'Poor' }] });
    const profile = build([verified, unverified, rejected, retracted, old], [medication('111'), medication('222')]);
    expect(profile.genes.map((g) => g.gene)).toEqual(['GENEA']);
    expect(profile.awaitingLinkReview).toEqual([{ evaluationId: unverified.evaluation.id, reportId: unverified.evaluation.reportId }]);
    // The unverified evaluation's result for 222 is never used.
    expect(profile.medications.map((m) => [m.rxcui, m.word])).toEqual([
      ['111', 'review'],
      ['222', 'no-guideline-loaded'],
    ]);
  });
});

describe('rule 2: a gene is resolved, in conflict, or not resolved, and every source is listed', () => {
  it('agrees across two sources', () => {
    const profile = build([evaluation({ genes: [{ gene: 'GENEA', phenotype: 'Normal' }] }), evaluation({ genes: [{ gene: 'GENEA', phenotype: 'Normal' }] })]);
    expect(profile.genes).toHaveLength(1);
    expect(profile.genes[0]).toMatchObject({ gene: 'GENEA', status: 'resolved' });
    expect(profile.genes[0]!.sources).toHaveLength(2);
  });
  it('shows a conflict when two sources disagree, keeping both', () => {
    const profile = build([evaluation({ genes: [{ gene: 'GENEA', phenotype: 'Normal' }] }), evaluation({ genes: [{ gene: 'GENEA', phenotype: 'Poor' }] })]);
    expect(profile.genes[0]!.status).toBe('conflict');
    expect(profile.genes[0]!.sources.map((s) => s.phenotype).sort()).toEqual(['Normal', 'Poor']);
  });
  it('compares an activity score when a source gives no phenotype', () => {
    const profile = build([evaluation({ genes: [{ gene: 'GENEB', activityScore: '1.0' }] }), evaluation({ genes: [{ gene: 'GENEB', activityScore: '0.5' }] })]);
    expect(profile.genes[0]!.status).toBe('conflict');
  });
  it('is not resolved when no source resolved it, and is not a conflict when one source only says less', () => {
    const unresolved = build([evaluation({ genes: [{ gene: 'GENEA', phenotype: null, reasonCode: 'no-phenotype-mapping' }] })]);
    expect(unresolved.genes[0]).toMatchObject({ status: 'not-resolved' });
    expect(unresolved.genes[0]!.sources[0]!.reasonCode).toBe('no-phenotype-mapping');
    const partly = build([evaluation({ genes: [{ gene: 'GENEA', phenotype: 'Normal' }] }), evaluation({ genes: [{ gene: 'GENEA', phenotype: null }] })]);
    expect(partly.genes[0]!.status).toBe('resolved');
    expect(partly.genes[0]!.sources).toHaveLength(2);
  });
  it('orders genes by name and sources by evaluation time', () => {
    const genes = [
      { gene: 'GENEB', phenotype: 'Poor' },
      { gene: 'GENEA', phenotype: 'Normal' },
    ];
    const later = evaluation({ createdAt: '2026-11-02T00:00:00.000Z', genes });
    const earlier = evaluation({ createdAt: '2026-11-01T00:00:00.000Z', genes: [{ gene: 'GENEA', phenotype: 'Normal' }] });
    const profile = build([later, earlier]);
    expect(profile.genes.map((g) => g.gene)).toEqual(['GENEA', 'GENEB']);
    expect(profile.genes[0]!.sources.map((s) => s.evaluationId)).toEqual([earlier.evaluation.id, later.evaluation.id]);
  });
});

describe('rule 3: a medication matches a result by RxCUI only', () => {
  it('ignores a result whose drug name matches but whose RxCUI differs (GP-4)', () => {
    const e = evaluation({ results: [{ outcome: 'shown', rxcui: '111', drug: 'same name' }] });
    expect(build([e], [medication('999', 'same name')]).medications[0]!.word).toBe('no-guideline-loaded');
  });
  it('never matches a synthetic syn-rxcui result to a real RxCUI medication (GP-6)', () => {
    const e = evaluation({ results: [{ outcome: 'shown', rxcui: 'syn-rxcui-drugx' }] });
    const profile = build([e], [medication('111')], '111');
    expect(profile.medications[0]!.word).toBe('no-guideline-loaded');
    expect(profile.check!.word).toBe('no-guideline-loaded');
  });
  it('never matches a result that carries no RxCUI (schema 1.2 knowledge)', () => {
    const e = evaluation({ results: [{ outcome: 'shown', rxcui: null }] });
    expect(build([e], [medication('111')]).medications[0]!.results).toEqual([]);
  });
  it('checks only current, active medications, in list order', () => {
    const e = evaluation({ results: [{ outcome: 'shown', rxcui: '111' }] });
    const stopped = medication('111', 'stopped one', { status: 'stopped' });
    const oldVersion = medication('333', 'old version', { current: false });
    const profile = build([e], [medication('222'), stopped, oldVersion, medication('111')]);
    expect(profile.medications.map((m) => m.rxcui)).toEqual(['222', '111']);
  });
});

describe('rule 4: the word, Review before Held before No recommendation (P1), with every result listed', () => {
  const words = (results: ResultSpec[]) => build([evaluation({ results })], [medication('111')]).medications[0]!;
  it('says review for a shown result, with its wording', () => {
    const check = words([{ outcome: 'shown', rxcui: '111' }]);
    expect(check.word).toBe('review');
    expect(check.results[0]).toMatchObject({ outcome: 'shown', strength: 'Strong', recommendationText: 'Synthetic wording.' });
  });
  it('says held for a held result', () => expect(words([{ outcome: 'held', rxcui: '111' }]).word).toBe('held'));
  it('says no-recommendation for an abstained or unpublished result', () => {
    expect(words([{ outcome: 'abstained', rxcui: '111' }]).word).toBe('no-recommendation');
    expect(words([{ outcome: 'no-published-recommendation', rxcui: '111' }]).word).toBe('no-recommendation');
  });
  it('says review when one source is shown and another held, and lists both', () => {
    const shown = evaluation({ results: [{ outcome: 'shown', rxcui: '111' }] });
    const held = evaluation({ results: [{ outcome: 'held', rxcui: '111' }] });
    const check = build([held, shown], [medication('111')]).medications[0]!;
    expect(check.word).toBe('review');
    expect(check.results.map((r) => r.outcome).sort()).toEqual(['held', 'shown']);
  });
  it('says held before no-recommendation', () => {
    const check = build([evaluation({ results: [{ outcome: 'abstained', rxcui: '111' }] }), evaluation({ results: [{ outcome: 'held', rxcui: '111' }] })], [medication('111')]);
    expect(check.medications[0]!.word).toBe('held');
  });
  it('uses no other word, and never a word that reads as safety (GP-5)', () => {
    const results = [
      { outcome: 'shown', rxcui: '1' },
      { outcome: 'held', rxcui: '2' },
      { outcome: 'abstained', rxcui: '3' },
    ];
    const profile = build([evaluation({ results })], [medication('1'), medication('2'), medication('3'), medication('4')]);
    expect(profile.medications.map((m) => m.word)).toEqual(['review', 'held', 'no-recommendation', 'no-guideline-loaded']);
    for (const m of profile.medications) expect(GENOMIC_CHECK_WORDS).toContain(m.word);
    expect(JSON.stringify(profile)).not.toMatch(/\b(safe|no interaction|normal response|ok)\b/i);
  });
});

describe('rule 5: a check is in conflict when a gene its result used is in conflict', () => {
  it('marks the check, and leaves a check on other genes unmarked', () => {
    const a = evaluation({ genes: [{ gene: 'GENEA', phenotype: 'Normal' }], results: [{ outcome: 'shown', rxcui: '111', genes: ['GENEA'] }] });
    const genes = [
      { gene: 'GENEA', phenotype: 'Poor' },
      { gene: 'GENEB', phenotype: 'Normal' },
    ];
    const b = evaluation({ genes, results: [{ outcome: 'shown', rxcui: '222', genes: ['GENEB'] }] });
    const profile = build([a, b], [medication('111'), medication('222')]);
    expect(profile.medications.map((m) => [m.rxcui, m.conflict])).toEqual([
      ['111', true],
      ['222', false],
    ]);
  });
});

describe('rule 6: guidelines changed', () => {
  it('is true when a matching result used guidelines that are no longer loaded', () => {
    const profile = build([evaluation({ knowledge: 'changed', results: [{ outcome: 'shown', rxcui: '111' }] })], [medication('111')]);
    expect(profile.medications[0]).toMatchObject({ word: 'review', knowledgeChanged: true });
  });
  it('is false when the matching result used the loaded guidelines, even if another evaluation did not', () => {
    const profile = build([evaluation({ knowledge: 'same', results: [{ outcome: 'shown', rxcui: '111' }] }), evaluation({ knowledge: 'changed' })], [medication('111')]);
    expect(profile.medications[0]!.knowledgeChanged).toBe(false);
  });
  it('is true for no-guideline-loaded when any used evaluation was made with other guidelines', () => {
    const profile = build([evaluation({ knowledge: 'changed' })], [medication('111')]);
    expect(profile.medications[0]).toMatchObject({ word: 'no-guideline-loaded', knowledgeChanged: true });
  });
  it('is false when the advisory is missing or unknown', () => {
    expect(build([evaluation({ results: [{ outcome: 'shown', rxcui: '111' }] })], [medication('111')]).medications[0]!.knowledgeChanged).toBe(false);
    expect(build([evaluation({ knowledge: 'unknown' })], [medication('111')]).medications[0]!.knowledgeChanged).toBe(false);
  });
});

describe('the whole profile', () => {
  it('with no guideline for any medication still lists the genes and answers every medication (GP-10)', () => {
    const profile = build([evaluation({ genes: [{ gene: 'GENEA', phenotype: 'Normal' }] })], [medication('111'), medication('222')]);
    expect(profile.genes).toHaveLength(1);
    expect(profile.medications.every((m) => m.word === 'no-guideline-loaded' && m.results.length === 0)).toBe(true);
  });
  it('has no check without ?rxcui=, carries the cap and the clinical-use label, and passes its strict schema', () => {
    const evaluations = [evaluation({ results: [{ outcome: 'shown', rxcui: '111' }] })];
    const profile = buildGenomicProfile({ patientId: PATIENT, evaluations, medications: [medication('111')], capped: true });
    expect(profile.check).toBeNull();
    expect(profile).toMatchObject({ capped: true, clinicalUse: 'not-approved' });
    expect(() => genomicProfileDtoSchema.parse(profile)).not.toThrow();
  });
  it('checks a drug that is not on the list, with a null name', () => {
    const profile = build([evaluation({ results: [{ outcome: 'held', rxcui: '555' }] })], [], '555');
    expect(profile.check).toMatchObject({ rxcui: '555', name: null, word: 'held' });
    expect(profile.medications).toEqual([]);
  });
});

// Spec 045 N2, rules 1 to 7 of plan-slice-n2.md. The lists are invented: GENEA and GENEB are invented genes, and no drug here is said to affect a
// real one. Every expected notice is written by hand.
describe('spec 045 N2: a notice when a current medication is listed against a gene (phenoconversion, notice only)', () => {
  const MODIFIER = '900';
  const modifier = (gene: string, over: Partial<ProfileModifier> = {}): ProfileModifier => ({
    gene,
    effect: 'inhibitor',
    strength: 'strong',
    locator: { table: 'Synthetic Table 1', row: 'drugm' },
    listId: 'syn-modifiers-a',
    source: 'SYNTHETIC TEST FIXTURE',
    sourceVersion: 'synthetic-1',
    sourceUrl: 'https://example.invalid/synthetic',
    ...over,
  });
  const lists = (entries: Record<string, ProfileModifier[]>): ModifierLookup => (rxcui) => entries[rxcui] ?? [];
  const usedGeneA = () =>
    evaluation({
      genes: [
        { gene: 'GENEA', phenotype: 'Poor' },
        { gene: 'GENEB', phenotype: 'Normal' },
      ],
      results: [{ outcome: 'shown', rxcui: '111', genes: ['GENEA'] }],
    });
  const withLists = (evaluations: ProfileEvaluation[], medications: ProfileMedication[], modifiersOf: ModifierLookup, checkRxcui?: string) =>
    buildGenomicProfile({ patientId: PATIENT, evaluations, medications, checkRxcui, capped: false, modifiersOf });
  const notice = {
    kind: 'gene-modifier',
    gene: 'GENEA',
    medication: { rxcui: MODIFIER, name: 'drugm', startRecorded: true },
    effect: 'inhibitor',
    strength: 'strong',
    source: {
      listId: 'syn-modifiers-a',
      source: 'SYNTHETIC TEST FIXTURE',
      sourceVersion: 'synthetic-1',
      sourceUrl: 'https://example.invalid/synthetic',
      table: 'Synthetic Table 1',
      row: 'drugm',
    },
  };

  it('names a current modifier of a gene the result used, with its effect, strength, source and locator (rule 2, PN-7)', () => {
    const medications = [medication('111', 'drugx'), medication(MODIFIER, 'drugm', { startMonth: '2026-01' })];
    const profile = withLists([usedGeneA()], medications, lists({ [MODIFIER]: [modifier('GENEA')] }));
    expect(profile.medications[0]!.contextNotices).toEqual([notice]);
    expect(profile.modifierLists).toEqual({ loaded: true });
    expect(() => genomicProfileDtoSchema.parse(profile)).not.toThrow();
  });

  it('gives no notice for a gene the result did not use, a stopped or earlier modifier, or a medication with only the same name (PN-2, PN-3)', () => {
    const rowOf = (medications: ProfileMedication[], entries: Record<string, ProfileModifier[]>) =>
      withLists([usedGeneA()], [medication('111', 'drugx'), ...medications], lists(entries)).medications[0]!.contextNotices;
    // control: the same modifier, current and active, of the gene the result used
    expect(rowOf([medication(MODIFIER, 'drugm')], { [MODIFIER]: [modifier('GENEA')] })).toHaveLength(1);
    expect(rowOf([medication(MODIFIER, 'drugm')], { [MODIFIER]: [modifier('GENEB')] })).toEqual([]);
    expect(rowOf([medication(MODIFIER, 'drugm', { status: 'stopped' })], { [MODIFIER]: [modifier('GENEA')] })).toEqual([]);
    expect(rowOf([medication(MODIFIER, 'drugm', { current: false })], { [MODIFIER]: [modifier('GENEA')] })).toEqual([]);
    expect(rowOf([medication('901', 'drugm')], { [MODIFIER]: [modifier('GENEA')] })).toEqual([]);
  });

  it('names the checked medication itself, an inducer as an inducer, and says when its start is not recorded (rules 2 and 6, N2-D2)', () => {
    const inducer = modifier('GENEA', { effect: 'inducer', strength: 'moderate', locator: { table: 'Synthetic Table 2' } });
    const profile = withLists([usedGeneA()], [medication('111', 'drugx')], lists({ '111': [inducer] }));
    expect(profile.medications[0]!.contextNotices).toEqual([
      {
        ...notice,
        medication: { rxcui: '111', name: 'drugx', startRecorded: false },
        effect: 'inducer',
        strength: 'moderate',
        source: { ...notice.source, table: 'Synthetic Table 2', row: null },
      },
    ]);
  });

  it('says nothing on a row with no matching result, whatever the patient takes (rule 3)', () => {
    const profile = withLists([usedGeneA()], [medication('222', 'drugy'), medication(MODIFIER, 'drugm')], lists({ [MODIFIER]: [modifier('GENEA')] }));
    expect(profile.medications.map((m) => [m.rxcui, m.word, m.contextNotices])).toEqual([
      ['222', 'no-guideline-loaded', []],
      [MODIFIER, 'no-guideline-loaded', []],
    ]);
  });

  it("puts a notice on a gene's card whether or not a result used the gene (rule 4)", () => {
    const profile = withLists([usedGeneA()], [medication(MODIFIER, 'drugm', { startMonth: '2026-01' })], lists({ [MODIFIER]: [modifier('GENEB')] }));
    expect(profile.genes.map((g) => [g.gene, g.contextNotices?.length])).toEqual([
      ['GENEA', 0],
      ['GENEB', 1],
    ]);
    expect(profile.genes[1]!.contextNotices![0]).toEqual({ ...notice, gene: 'GENEB' });
  });

  it('gives one notice per gene and medication, in gene order and then medication name order (rule 5)', () => {
    const e = evaluation({ genes: [{ gene: 'GENEA', phenotype: 'Poor' }], results: [{ outcome: 'shown', rxcui: '111', genes: ['GENEA'] }] });
    const twice = [modifier('GENEA'), modifier('GENEA', { listId: 'syn-modifiers-b' })];
    const medications = [medication('111', 'drugx'), medication('902', 'zeta'), medication('903', 'alpha'), medication('903', 'alpha')];
    const profile = withLists([e], medications, lists({ '902': [modifier('GENEA')], '903': twice }));
    expect(profile.medications[0]!.contextNotices!.map((n) => [n.gene, n.medication.name, n.source.listId])).toEqual([
      ['GENEA', 'alpha', 'syn-modifiers-a'],
      ['GENEA', 'zeta', 'syn-modifiers-a'],
    ]);
  });

  it('carries notices on a drug checked before prescribing', () => {
    const profile = withLists([usedGeneA()], [medication(MODIFIER, 'drugm', { startMonth: '2026-01' })], lists({ [MODIFIER]: [modifier('GENEA')] }), '111');
    expect(profile.check!.contextNotices).toEqual([notice]);
  });

  it('changes nothing else: the response with lists equals the one without, once the notices are removed (PN-4)', () => {
    const evaluations = [usedGeneA()];
    const medications = [medication('111', 'drugx'), medication(MODIFIER, 'drugm')];
    function strip(value: unknown): unknown {
      if (Array.isArray(value)) return value.map(strip);
      if (value === null || typeof value !== 'object') return value;
      const kept = Object.entries(value).filter(([key]) => key !== 'contextNotices' && key !== 'modifierLists');
      return Object.fromEntries(kept.map(([key, inner]) => [key, strip(inner)]));
    }
    const before = buildGenomicProfile({ patientId: PATIENT, evaluations, medications, checkRxcui: '111', capped: false });
    const after = withLists(evaluations, medications, lists({ [MODIFIER]: [modifier('GENEA'), modifier('GENEB')] }), '111');
    expect(after.medications[0]!.contextNotices).toHaveLength(1);
    expect(strip(after)).toEqual(strip(before));
  });

  it('with no list loaded, carries no notice anywhere and says so (rule 7, PN-6)', () => {
    const profile = build([usedGeneA()], [medication('111', 'drugx'), medication(MODIFIER, 'drugm')], '111');
    expect(profile.modifierLists).toEqual({ loaded: false });
    for (const item of [...profile.genes, ...profile.medications, profile.check!]) expect(item).not.toHaveProperty('contextNotices');
  });

  it('never reassures (PN-5)', () => {
    const profile = withLists([usedGeneA()], [medication('111', 'drugx'), medication(MODIFIER, 'drugm')], lists({ [MODIFIER]: [modifier('GENEA')] }), '111');
    expect(JSON.stringify(profile)).not.toMatch(/\b(safe|no interaction|not affected|normal response|ok)\b/i);
  });
});
