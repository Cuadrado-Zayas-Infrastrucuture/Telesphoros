import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CPIC_STRENGTHS, type DrugResult, type EvaluationResult, evaluationResultSchema, type GeneInput, REASON_OUTCOME } from '@telesphoros/cpic-schema';
import { RECOMMENDATION_STRENGTHS } from '@telesphoros/shared-types';
import { loadKnowledge } from '../knowledge/knowledge-loader';
import type { KnowledgeSet } from '../knowledge/knowledge-set';
import { cleanupTempDirs, copyOf, readJson, reviewedCopyOf, SYNTHETIC_DIR, tempDir, TEST_SIGNER_KEYS, writeJson } from '../../../test/helpers/knowledge';
import { EngineInputError, evaluate } from './recommendation-engine';

let knowledge: KnowledgeSet;
beforeAll(async () => {
  knowledge = await loadKnowledge({ directory: SYNTHETIC_DIR, mode: 'non-production' });
});
afterAll(cleanupTempDirs);

const canonical = (gene: string, phenotype: string): GeneInput => ({ gene, state: 'canonical', phenotype });
const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
};

describe('evaluate: contract', () => {
  it('always returns a result that matches the published result schema, and names the knowledge it used', () => {
    const result = evaluate(knowledge, [canonical('GENEA', 'Synthetic Normal'), canonical('GENEE', 'Synthetic Fast')]);
    expect(evaluationResultSchema.safeParse(result).success).toBe(true);
    expect(result.knowledgeSetId).toBe(knowledge.id);
  });

  it('shares its strength vocabulary with the API types, so the two cannot drift apart', () => {
    expect([...CPIC_STRENGTHS]).toEqual([...RECOMMENDATION_STRENGTHS]);
  });

  it.each([
    ['a lower-case gene', [{ gene: 'genea', state: 'canonical', phenotype: 'x' }], {}],
    ['an unknown state', [{ gene: 'GENEA', state: 'absent' }], {}],
    ['an unknown key', [{ gene: 'GENEA', state: 'null', extra: 1 }], {}],
    ['a reason only the engine may give', [{ gene: 'GENEA', state: 'unresolved', reasonCode: 'gene-absent' }], {}],
    ['a badly written drug name', [], { drugs: ['Not A Drug!'] }],
    ['too many inputs', Array.from({ length: 201 }, () => canonical('GENEA', 'x')), {}],
  ])('refuses %s with an error that repeats none of the input', (_name, inputs, options) => {
    let thrown: unknown;
    try {
      evaluate(knowledge, inputs as never, options as never);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(EngineInputError);
    expect(String((thrown as Error).message)).not.toMatch(/genea|Not A Drug/i);
  });
});

describe('evaluate: what may be shown, checked over EVERY combination of states for the combined table’s genes', () => {
  // Every way GENEA and GENEE can arrive, including the ways that must never produce a recommendation.
  const forGene = (gene: string, phenotypes: string[], diplotype?: string): GeneInput[][] => [
    [], // absent
    ...phenotypes.map((phenotype) => [canonical(gene, phenotype)]),
    [canonical(gene, 'Not A Canonical Term')],
    [{ gene, state: 'null' }],
    [{ gene, state: 'unresolved', reasonCode: 'other-gene-unresolved' }],
    [{ gene, state: 'unresolved', reasonCode: 'association-abstained' }],
    [canonical(gene, phenotypes[0]!), canonical(gene, phenotypes[0]!)], // duplicate, identical
    [canonical(gene, phenotypes[0]!), canonical(gene, phenotypes[1]!)], // duplicate, different
    ...(diplotype ? [[{ gene, state: 'diplotype', diplotype } as GeneInput], [{ gene, state: 'diplotype', diplotype: '*9/*9' } as GeneInput]] : []),
  ];
  const geneA = forGene('GENEA', ['Synthetic Normal', 'Synthetic Intermediate', 'Synthetic Poor'], '*1/*3');
  const geneE = forGene('GENEE', ['Synthetic Fast', 'Synthetic Slow']);
  let allWording: string[];
  let all: { inputs: GeneInput[]; result: EvaluationResult }[];
  let results: DrugResult[];
  beforeAll(() => {
    allWording = knowledge
      .drugs()
      .flatMap((drug) =>
        knowledge
          .guidelinesForDrug(drug)
          .flatMap((guideline) => guideline.recommendations.flatMap((row) => [row.recommendationText, ...(row.implication ? [row.implication] : [])])),
      );
    all = [];
    for (const a of geneA)
      for (const e of geneE) {
        const inputs = [...a, ...e];
        all.push({ inputs, result: evaluate(knowledge, inputs) });
      }
    results = all.flatMap(({ result }) => result.results);
  });

  it('the sweep is large enough to mean something, and reaches every outcome', () => {
    expect(all.length).toBeGreaterThan(100);
    const floors = { shown: 20, held: 100, abstained: 5, 'no-published-recommendation': 2 } as const;
    for (const [outcome, floor] of Object.entries(floors)) {
      expect(results.filter((r) => r.outcome === outcome).length).toBeGreaterThanOrEqual(floor);
    }
    expect(all.every(({ result }) => evaluationResultSchema.safeParse(result).success)).toBe(true);
  });

  it('a result is shown only for a verified cell found by an independent lookup, with every gene canonical', () => {
    const shown = results.filter((r): r is Extract<DrugResult, { outcome: 'shown' }> => r.outcome === 'shown');
    expect(shown.length).toBeGreaterThan(20);
    for (const result of shown) {
      const guideline = knowledge.guidelinesForDrug(result.drug).find((g) => g.id === result.citation.guidelineId)!;
      const row = guideline.recommendations.find((candidate) => result.geneStates.every((gene) => candidate.when[gene.gene] === gene.phenotype))!;
      expect(row).toBeDefined();
      expect(row.verification.state).toBe('verified');
      expect(result.citation.verification).toBe('verified');
      expect(result.recommendationText).toBe(row.recommendationText);
      expect(result.strength).toBe(row.strength);
      expect(row.strength).not.toBe('No recommendation');
      expect(result.citation.locator).toEqual({ table: row.locator.table, row: row.locator.row, column: row.locator.column ?? null });
      expect(result.geneStates.every((gene) => gene.state === 'canonical')).toBe(true);
    }
  });

  it('whenever any gene behind a result is not a clean canonical phenotype, the result is never shown or "no published recommendation"', () => {
    for (const result of results) {
      if (result.outcome === 'no-guideline') continue;
      if (result.geneStates.some((gene) => gene.state !== 'canonical')) {
        expect(['held', 'abstained']).toContain(result.outcome);
      }
    }
  });

  it('the wording of a held, abstained or unverified-cell result never appears anywhere in it', () => {
    for (const result of results) {
      if (result.outcome !== 'held' && result.outcome !== 'abstained') continue;
      const text = JSON.stringify(result);
      for (const wording of allWording) expect(text.includes(wording)).toBe(false);
    }
    // ...including the cells that exist but are not verified.
    const heldWithCell = results.filter((r): r is Extract<DrugResult, { outcome: 'held' }> => r.outcome === 'held' && r.citation !== null);
    expect(heldWithCell.some((r) => r.reasonCode === 'out-of-review-scope')).toBe(true);
    expect(heldWithCell.some((r) => r.reasonCode === 'cell-disputed')).toBe(true);
  });

  it('"no published recommendation" always comes from a verified cell that says so, with its citation; a missing cell is never read as one', () => {
    const none = results.filter((r): r is Extract<DrugResult, { outcome: 'no-published-recommendation' }> => r.outcome === 'no-published-recommendation');
    expect(none.length).toBeGreaterThanOrEqual(2);
    for (const result of none) {
      expect(result.citation).not.toBeNull();
      expect(result.strength).toBe('No recommendation');
    }
    expect(results.some((r) => r.outcome === 'held' && r.reasonCode === 'knowledge-gap')).toBe(true);
  });

  it('every non-shown result carries a reason whose outcome is the one it reports', () => {
    for (const result of results) {
      if (result.outcome === 'shown') continue;
      expect(REASON_OUTCOME[result.reasonCode]).toBe(result.outcome);
    }
  });

  it('a table replaced by a combined one is never shown on its own, whatever the genes do', () => {
    const drugv = results.filter((r) => r.drug === 'drugv');
    expect(drugv.length).toBe(all.length); // exactly one result per evaluation
    for (const result of drugv) {
      expect(result.genes).toEqual(['GENEA', 'GENEE']);
      if (result.outcome === 'shown' || result.outcome === 'held' || result.outcome === 'no-published-recommendation') {
        expect(result.citation?.guidelineId ?? 'drugv-genea-genee').toBe('drugv-genea-genee');
      }
    }
  });
});

describe('evaluate: determinism and purity', () => {
  const inputs: GeneInput[] = [canonical('GENEC', 'Synthetic Alpha'), canonical('GENEA', 'Synthetic Intermediate'), { gene: 'GENEB', state: 'diplotype', diplotype: '*2/*4' }];

  it('gives identical output for identical input, in a fixed order', () => {
    const first = evaluate(knowledge, inputs);
    for (let i = 0; i < 5; i += 1) expect(evaluate(knowledge, inputs)).toEqual(first);
    expect(first.geneStates.map((g) => g.gene)).toEqual([...first.geneStates.map((g) => g.gene)].sort());
    expect(first.results.map((r) => r.drug)).toEqual([...first.results.map((r) => r.drug)].sort());
  });

  it('does not depend on the order of inputs or of drugs, and a repeated drug is evaluated once', () => {
    const forward = evaluate(knowledge, inputs, { drugs: ['drugx', 'drugy'] });
    expect(evaluate(knowledge, [...inputs].reverse(), { drugs: ['drugy', 'drugx', 'drugx'] })).toEqual(forward);
  });

  it('does not change its inputs or the knowledge', () => {
    const frozen = deepFreeze(structuredClone(inputs));
    const before = JSON.stringify(knowledge.guidelinesForDrug('drugv'));
    expect(() => evaluate(knowledge, frozen, deepFreeze({ drugs: ['drugx', 'drugv'] }))).not.toThrow();
    expect(JSON.stringify(knowledge.guidelinesForDrug('drugv'))).toBe(before);
  });

  it('an empty drug list means "no drugs", not "all drugs"', () => {
    expect(evaluate(knowledge, inputs, { drugs: [] }).results).toEqual([]);
    expect(evaluate(knowledge, inputs).results.length).toBeGreaterThan(0);
  });
});

describe('evaluate: privacy', () => {
  it('never copies a value from the report into a result', () => {
    const result = evaluate(knowledge, [
      canonical('GENEA', 'SECRET-PHENOTYPE'),
      { gene: 'GENEC', state: 'diplotype', diplotype: '*SECRET-ONE|*1' },
      { gene: 'GENEB', state: 'diplotype', diplotype: '*SECRET-TWO/*1' },
    ]);
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });
});

describe('evaluate: when no guidelines are loaded', () => {
  let empty: KnowledgeSet;
  beforeAll(async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'guidelines'));
    await writeFile(join(dir, 'guidelines/.gitkeep'), '');
    empty = await loadKnowledge({ directory: dir, mode: 'production' });
  });

  it('says so for a requested drug, and cannot interpret any gene', () => {
    const result = evaluate(empty, [canonical('GENEA', 'Synthetic Normal')], { drugs: ['drugx'] });
    expect(result.geneStates).toEqual([{ gene: 'GENEA', state: 'unresolved', phenotype: null, diplotype: null, activityScore: null, reasonCode: 'no-gene-definition' }]);
    expect(result.results).toEqual([{ outcome: 'no-guideline', drug: 'drugx', genes: [], geneStates: [], reasonCode: 'no-guideline-for-drug' }]);
  });

  it('has nothing to evaluate when no drug is named', () => {
    expect(evaluate(empty, [canonical('GENEA', 'Synthetic Normal')]).results).toEqual([]);
  });
});

describe('evaluate: standard identifiers on results (spec 033 K2-6)', () => {
  // Expected identifiers are written by hand from data/fixtures/knowledge/synthetic-identifiers, never read back from the engine.
  const IDENTIFIERS_DIR = join(SYNTHETIC_DIR, '../synthetic-identifiers');
  const STRUCTURED_DIR = join(SYNTHETIC_DIR, '../synthetic-structured');
  const PHENOTYPES_A = ['Synthetic Normal', 'Synthetic Intermediate', 'Synthetic Poor'];
  const PHENOTYPES_B = ['Synthetic Low', 'Synthetic Medium', 'Synthetic High'];
  const GENE_A = { gene: 'GENEA', hgncId: 'syn-hgnc-genea', pharmvarVersion: 'syn-pharmvar-1.0' };
  const GENE_B = { gene: 'GENEB', hgncId: 'syn-hgnc-geneb', pharmvarVersion: 'syn-pharmvar-1.0' };
  let identified: KnowledgeSet;
  let structured: KnowledgeSet;
  beforeAll(async () => {
    identified = await loadKnowledge({ directory: IDENTIFIERS_DIR, mode: 'non-production' });
    structured = await loadKnowledge({ directory: STRUCTURED_DIR, mode: 'non-production' });
  });
  const run = (set: KnowledgeSet, a: string, b: string) => evaluate(set, [canonical('GENEA', a), canonical('GENEB', b)]).results;
  const byDrug = (results: DrugResult[], drug: string) => results.find((result) => result.drug === drug)!;

  it('copies the RxCUI, the HGNC id and PharmVar release of each gene, and the origin of the cell', () => {
    const results = run(identified, 'Synthetic Normal', 'Synthetic Low');
    expect(byDrug(results, 'drugz')).toMatchObject({ outcome: 'shown', identifiers: { rxcui: 'syn-rxcui-drugz', genes: [GENE_A, GENE_B], origin: 'cpic' } });
    expect(byDrug(results, 'drugq')).toMatchObject({ outcome: 'shown', identifiers: { rxcui: 'syn-rxcui-drugq', genes: [GENE_A], origin: 'cpic' } });
    const intermediate = run(identified, 'Synthetic Intermediate', 'Synthetic Low');
    expect(byDrug(intermediate, 'drugq')).toMatchObject({ outcome: 'shown', identifiers: { origin: 'pharmgkb' } });
    // an unverified cell is held without its wording, but still names its identifiers so a reviewer can find it
    expect(byDrug(intermediate, 'drugz')).toMatchObject({ outcome: 'held', reasonCode: 'out-of-review-scope', identifiers: { rxcui: 'syn-rxcui-drugz', origin: 'unknown' } });
    expect(byDrug(run(identified, 'Synthetic Poor', 'Synthetic High'), 'drugz')).toMatchObject({ outcome: 'no-published-recommendation', identifiers: { origin: 'cpic' } });
  });

  it('never changes an outcome: over every combination, results equal those from the same cells without identifiers', () => {
    for (const a of PHENOTYPES_A) {
      for (const b of PHENOTYPES_B) {
        const withIds = run(identified, a, b).map((result) => {
          const { identifiers: _ids, ...rest } = result as DrugResult & { identifiers?: unknown };
          void _ids;
          return rest;
        });
        expect({ a, b, results: withIds }).toEqual({ a, b, results: run(structured, a, b) });
        expect(evaluationResultSchema.safeParse(evaluate(identified, [canonical('GENEA', a), canonical('GENEB', b)])).success).toBe(true);
      }
    }
  });

  it('adds nothing to results from schema 1.2 knowledge, or where no cell applies', () => {
    for (const result of evaluate(knowledge, [canonical('GENEA', 'Synthetic Normal'), canonical('GENEE', 'Synthetic Fast')]).results) expect('identifiers' in result).toBe(false);
    // GENEB missing: the combined table is held with no cell, so there is nothing to identify
    const held = byDrug(evaluate(identified, [canonical('GENEA', 'Synthetic Normal')]).results, 'drugz');
    expect(held).toMatchObject({ outcome: 'held', citation: null });
    expect('identifiers' in held).toBe(false);
    // a combination with no cell
    const none = byDrug(run(identified, 'Synthetic Intermediate', 'Synthetic High'), 'drugz');
    expect(none).toMatchObject({ outcome: 'held', reasonCode: 'knowledge-gap', citation: null });
    expect('identifiers' in none).toBe(false);
  });

  it('adds nothing when any gene map the guideline reads is still schema 1.2', async () => {
    const dir = await copyOf(IDENTIFIERS_DIR);
    const path = join(dir, 'phenotypes/geneb.json');
    const { hgncId: _h, origin: _o, pharmvarVersion: _p, ...map } = (await readJson(path)) as unknown as Record<string, unknown>;
    void [_h, _o, _p];
    await writeJson(path, { ...map, schemaVersion: '1.2' });
    const results = run(await loadKnowledge({ directory: dir, mode: 'non-production' }), 'Synthetic Normal', 'Synthetic Low');
    expect('identifiers' in byDrug(results, 'drugz')).toBe(false); // reads GENEB
    expect(byDrug(results, 'drugq')).toMatchObject({ identifiers: { rxcui: 'syn-rxcui-drugq' } }); // reads GENEA only
  });
});

describe('evaluate: the signers of the cited file are named in the citation (audit CLIN-01)', () => {
  const drugx = (set: KnowledgeSet) =>
    evaluate(set, [canonical('GENEA', 'Synthetic Normal')], { drugs: ['drugx'] }).results.find((r) => (r.genes as readonly string[]).includes('GENEA'))!;

  it('names the signers whose signatures the production load verified', async () => {
    const signed = await loadKnowledge({ directory: await reviewedCopyOf(SYNTHETIC_DIR), mode: 'production', signerKeys: TEST_SIGNER_KEYS });
    const result = drugx(signed);
    expect(result.outcome).toBe('shown');
    expect(result.outcome === 'shown' && result.citation.signedBy).toEqual(['test-signer-a', 'test-signer-b']);
    expect(evaluationResultSchema.safeParse(evaluate(signed, [canonical('GENEA', 'Synthetic Normal')])).success).toBe(true);
  });

  it('adds nothing outside production, so every existing citation keeps its exact shape', () => {
    const result = drugx(knowledge);
    expect(result.outcome === 'shown' && 'signedBy' in result.citation).toBe(false);
  });
});

describe('evaluate: a combination with no cell is held, never "no published recommendation" (audit DATA-01)', () => {
  // In the synthetic fixtures drugy-geneb has no cell for GENEB "Synthetic High", and the combined drugv-genea-genee, which replaces
  // drugv-genea, has none for Poor + Slow although drugv-genea has a verified Strong cell for Poor.
  // drugx has a table per gene; the first gene named picks the table.
  const only = (set: KnowledgeSet, inputs: GeneInput[], drug: string) =>
    evaluate(set, inputs, { drugs: [drug] }).results.find((result) => (result.genes as readonly string[]).includes(inputs[0]!.gene))!;
  const gap = { outcome: 'held', reasonCode: 'knowledge-gap', citation: null };

  it('a phenotype the table has no cell for is held as knowledge-gap, with no citation, strength or wording', () => {
    const result = only(knowledge, [canonical('GENEB', 'Synthetic High')], 'drugy');
    expect(result).toMatchObject(gap);
    expect(result).not.toHaveProperty('recommendationText');
    expect(result).not.toHaveProperty('strength');
    expect(REASON_OUTCOME['knowledge-gap']).toBe('held');
  });

  it('a combination missing from a combined table is held; the single-gene table it replaces is not consulted', () => {
    expect(only(knowledge, [canonical('GENEA', 'Synthetic Poor'), canonical('GENEE', 'Synthetic Slow')], 'drugv')).toMatchObject(gap);
  });

  it('control: a verified "No recommendation" cell still reports no-published-recommendation, with its citation and wording', () => {
    const result = only(knowledge, [canonical('GENEC', 'Synthetic Beta')], 'drugx');
    expect(result).toMatchObject({ outcome: 'no-published-recommendation', reasonCode: 'no-published-recommendation', strength: 'No recommendation' });
    expect(result.outcome === 'no-published-recommendation' && result.citation).toMatchObject({ guidelineId: 'drugx-genec' });
  });

  it('a combination the signed file marks as not covered is held the same way: nothing published says what to do', async () => {
    const signed = await loadKnowledge({ directory: await reviewedCopyOf(SYNTHETIC_DIR), mode: 'production', signerKeys: TEST_SIGNER_KEYS });
    const drugv = signed.guidelinesForDrug('drugv').find((guideline) => guideline.id === 'drugv-genea-genee')!;
    expect(drugv.notCovered).toEqual([{ when: { GENEA: 'Synthetic Poor', GENEE: 'Synthetic Slow' }, note: expect.any(String) }]);
    expect(only(signed, [canonical('GENEA', 'Synthetic Poor'), canonical('GENEE', 'Synthetic Slow')], 'drugv')).toMatchObject(gap);
    expect(only(signed, [canonical('GENEB', 'Synthetic High')], 'drugy')).toMatchObject(gap);
  });
});
