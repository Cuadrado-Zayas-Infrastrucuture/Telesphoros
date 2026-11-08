import {
  type Citation,
  type DrugResult,
  evaluationOptionsSchema,
  type EvaluationOptions,
  type EvaluationResult,
  type GeneEvidence,
  type GeneInput,
  geneInputsSchema,
  type GeneStateResult,
  type GuidelineFile,
  type ReasonCode,
  REASON_OUTCOME,
  REASON_PRECEDENCE,
  type RecommendationRow,
  type ResultIdentifiers,
} from '@telesphoros/cpic-schema';
import { mapPhenotype } from '../phenotype-engine/phenotype-engine';
import type { KnowledgeSet } from '../knowledge/knowledge-set';

/** Thrown for a programming error (input that breaks the contract). The message never includes input values. */
export class EngineInputError extends Error {
  constructor() {
    super('The engine was given input that does not match its contract.');
    this.name = 'EngineInputError';
  }
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The deterministic rules engine: gene inputs + knowledge in, one result per drug and guideline out.
 *
 *  - It never decides anything itself: wording, strength and version are copied from the guideline.
 *  - A result is `shown` only when every gene resolved to a canonical phenotype AND the guideline has
 *    a cell for exactly that combination AND that cell has been verified. Every other case is one of
 *    the other four outcomes, with a reason code. Nothing is guessed, and a narrower row is never
 *    substituted for a combined table that cannot be applied.
 *  - Same input and knowledge always give the same output, in a fixed order. No clock, no I/O.
 */
export function evaluate(knowledge: KnowledgeSet, inputs: readonly GeneInput[], options: EvaluationOptions = {}): EvaluationResult {
  const parsedInputs = geneInputsSchema.safeParse(inputs);
  const parsedOptions = evaluationOptionsSchema.safeParse(options);
  if (!parsedInputs.success || !parsedOptions.success) throw new EngineInputError();

  const supplied = resolveSupplied(knowledge, parsedInputs.data);
  const stateOf = (gene: string): GeneStateResult => supplied.get(gene) ?? absent(gene);

  const drugs = [...new Set(parsedOptions.data.drugs ?? knowledge.drugs())].sort(byText);
  const results: DrugResult[] = [];
  const needed = new Set<string>();
  for (const drug of drugs) {
    const guidelines = knowledge.guidelinesForDrug(drug);
    if (guidelines.length === 0) {
      results.push({ outcome: 'no-guideline', drug, genes: [], geneStates: [], reasonCode: 'no-guideline-for-drug' });
      continue;
    }
    // A combined table replaces the narrower tables it names: those are never shown on their own.
    const superseded = new Set(guidelines.flatMap((guideline) => guideline.supersedes));
    for (const guideline of guidelines) {
      if (superseded.has(guideline.id)) continue;
      guideline.genes.forEach((gene) => needed.add(gene));
      results.push(evaluateGuideline(knowledge, guideline, stateOf));
    }
  }

  const geneStates = [...new Set([...supplied.keys(), ...needed])].sort(byText).map(stateOf);
  return { knowledgeSetId: knowledge.id, geneStates, results };
}

const absent = (gene: string): GeneStateResult => ({ gene, state: 'absent', phenotype: null, diplotype: null, activityScore: null, reasonCode: 'gene-absent' });
const unresolved = (gene: string, reasonCode: ReasonCode): GeneStateResult => ({ gene, state: 'unresolved', phenotype: null, diplotype: null, activityScore: null, reasonCode });

/** One state per gene the report mentions. A gene mentioned twice is never resolved by picking one. */
function resolveSupplied(knowledge: KnowledgeSet, inputs: readonly GeneInput[]): Map<string, GeneStateResult> {
  const byGene = new Map<string, GeneInput[]>();
  for (const input of inputs) byGene.set(input.gene, [...(byGene.get(input.gene) ?? []), input]);

  const states = new Map<string, GeneStateResult>();
  for (const gene of [...byGene.keys()].sort(byText)) {
    const occurrences = byGene.get(gene)!;
    if (occurrences.length > 1) {
      const first = JSON.stringify(occurrences[0]);
      const identical = occurrences.every((occurrence) => JSON.stringify(occurrence) === first);
      states.set(gene, unresolved(gene, identical ? 'duplicate-identical' : 'duplicate-gene-conflict'));
      continue;
    }
    states.set(gene, resolveOne(knowledge, occurrences[0]!));
  }
  return states;
}

function resolveOne(knowledge: KnowledgeSet, input: GeneInput): GeneStateResult {
  const { gene } = input;
  switch (input.state) {
    case 'null':
      return { gene, state: 'null', phenotype: null, diplotype: null, activityScore: null, reasonCode: 'sentinel-literal-in-source' };
    case 'unresolved':
      return unresolved(gene, input.reasonCode);
    case 'canonical': {
      const map = knowledge.gene(gene);
      if (!map) return unresolved(gene, 'no-gene-definition');
      // Only the gene's own canonical terms are recognized: no case folding, no synonyms.
      if (!map.phenotypes.includes(input.phenotype)) return unresolved(gene, 'other-gene-unresolved');
      return { gene, state: 'canonical', phenotype: input.phenotype, diplotype: null, activityScore: null, reasonCode: null };
    }
    case 'diplotype': {
      const map = knowledge.gene(gene);
      if (!map) return unresolved(gene, 'no-gene-definition');
      const mapped = mapPhenotype(map, input.diplotype);
      if (mapped.status === 'unresolved') return unresolved(gene, mapped.reasonCode);
      return { gene, state: 'canonical', phenotype: mapped.phenotype, diplotype: mapped.diplotype, activityScore: mapped.activityScore, reasonCode: null };
    }
  }
}

const evidence = (state: GeneStateResult): GeneEvidence => ({ gene: state.gene, state: state.state, phenotype: state.phenotype, reasonCode: state.reasonCode });

function citationFor(knowledge: KnowledgeSet, guideline: GuidelineFile, row: RecommendationRow): Citation {
  // Only signers the production load verified; nothing is added otherwise, so an unsigned citation keeps its exact shape.
  const signedBy = knowledge.files.find((file) => file.id === guideline.id)?.signedBy;
  return {
    guidelineId: guideline.id,
    guidelineVersion: guideline.guidelineVersion,
    sourceUrl: guideline.provenance.sourceUrl,
    locator: { table: row.locator.table, row: row.locator.row, column: row.locator.column ?? null },
    verification: row.verification.state,
    ...(signedBy && signedBy.length > 0 ? { signedBy: [...signedBy] } : {}),
  };
}

/**
 * The standard identifiers of a cell (spec 033 K2-6), only when the guideline and every gene map it reads are schema 1.3.
 * Copied, never looked up elsewhere, and never used to choose a cell or an outcome.
 */
function identifiersFor(knowledge: KnowledgeSet, guideline: GuidelineFile, row: RecommendationRow): { identifiers?: ResultIdentifiers } {
  if (guideline.schemaVersion !== '1.3' || guideline.rxcui === undefined || row.origin === undefined) return {};
  const genes: ResultIdentifiers['genes'] = [];
  for (const gene of guideline.genes) {
    const map = knowledge.gene(gene);
    if (map?.schemaVersion !== '1.3' || map.hgncId === undefined) return {};
    genes.push({ gene, hgncId: map.hgncId, pharmvarVersion: map.pharmvarVersion ?? null });
  }
  return { identifiers: { rxcui: guideline.rxcui, genes, origin: row.origin } };
}

function evaluateGuideline(knowledge: KnowledgeSet, guideline: GuidelineFile, stateOf: (gene: string) => GeneStateResult): DrugResult {
  const { drug, genes } = guideline;
  const states = genes.map(stateOf);
  const geneStates = states.map(evidence);

  // Any gene that is not a clean canonical phenotype stops the whole table: no fallback to a narrower row.
  const problems = states.flatMap((state) => (state.reasonCode === null ? [] : [state.reasonCode]));
  if (problems.length > 0) {
    const reasonCode = REASON_PRECEDENCE.find((code) => problems.includes(code)) ?? problems[0]!;
    return REASON_OUTCOME[reasonCode] === 'abstained'
      ? { outcome: 'abstained', drug, genes, geneStates, reasonCode: 'association-abstained' }
      : { outcome: 'held', drug, genes, geneStates, reasonCode, citation: null };
  }

  const phenotypes = new Map(states.map((state) => [state.gene, state.phenotype]));
  const row = guideline.recommendations.find((candidate) => genes.every((gene) => candidate.when[gene] === phenotypes.get(gene)));
  // No cell for this combination is a gap in the knowledge, not a published "No recommendation": a person must look (audit DATA-01).
  if (!row) return { outcome: 'held', drug, genes, geneStates, reasonCode: 'knowledge-gap', citation: null };

  const citation = citationFor(knowledge, guideline, row);
  const ids = identifiersFor(knowledge, guideline, row);
  // The wording of a cell that has not been verified is never exposed, not even to a reviewer-facing field.
  if (row.verification.state === 'unverified') return { outcome: 'held', drug, genes, geneStates, reasonCode: 'out-of-review-scope', citation, ...ids };
  if (row.verification.state === 'disputed') return { outcome: 'held', drug, genes, geneStates, reasonCode: 'cell-disputed', citation, ...ids };

  if (row.strength === 'No recommendation') {
    return {
      outcome: 'no-published-recommendation',
      drug,
      genes,
      geneStates,
      reasonCode: 'no-published-recommendation',
      citation,
      strength: row.strength,
      recommendationText: row.recommendationText,
      implication: row.implication ?? null,
      ...ids,
    };
  }
  return { outcome: 'shown', drug, genes, geneStates, strength: row.strength, citation, recommendationText: row.recommendationText, implication: row.implication ?? null, ...ids };
}
