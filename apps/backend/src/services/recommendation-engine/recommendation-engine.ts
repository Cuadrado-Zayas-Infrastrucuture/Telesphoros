import {
  evaluationOptionsSchema,
  type EvaluationOptions,
  type EvaluationResult,
  type GeneCall,
  geneCallsSchema,
  type PhenotypeResult,
  type RecommendationResult,
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
 * The deterministic rules engine: gene calls + knowledge in, phenotypes and recommendations out.
 *
 *  - It never decides anything itself: wording, strength and version are copied from the guideline.
 *  - A recommendation exists only when the phenotype was DETERMINED and the guideline has a row for
 *    exactly that phenotype. Every other case is an explicit "indeterminate" with a reason code.
 *  - Same input and knowledge always give the same output, in a fixed order. No clock, no I/O.
 */
export function evaluate(knowledge: KnowledgeSet, calls: readonly GeneCall[], options: EvaluationOptions = {}): EvaluationResult {
  const parsedCalls = geneCallsSchema.safeParse(calls);
  const parsedOptions = evaluationOptionsSchema.safeParse(options);
  if (!parsedCalls.success || !parsedOptions.success) throw new EngineInputError();

  const phenotypes = resolvePhenotypes(knowledge, parsedCalls.data);
  const phenotypeByGene = new Map(phenotypes.map((result) => [result.gene, result]));

  const drugs = [...new Set(parsedOptions.data.drugs ?? knowledge.drugs())].sort(byText);
  const recommendations: RecommendationResult[] = [];
  for (const drug of drugs) {
    const guidelines = knowledge.guidelinesForDrug(drug);
    if (guidelines.length === 0) {
      recommendations.push({ status: 'indeterminate', drug, gene: null, reasonCode: 'NO_MATCHING_GUIDELINE' });
      continue;
    }
    for (const guideline of guidelines) {
      const phenotype = phenotypeByGene.get(guideline.gene);
      if (!phenotype) {
        recommendations.push({ status: 'indeterminate', drug, gene: guideline.gene, reasonCode: 'GENE_NOT_IN_REPORT' });
      } else if (phenotype.status === 'indeterminate') {
        recommendations.push({ status: 'indeterminate', drug, gene: guideline.gene, reasonCode: phenotype.reasonCode });
      } else {
        const row = guideline.recommendations.find((candidate) => candidate.phenotype === phenotype.phenotype);
        recommendations.push(
          row
            ? {
                status: 'recommendation',
                gene: guideline.gene,
                drug,
                diplotype: phenotype.diplotype,
                phenotype: phenotype.phenotype,
                strength: row.strength,
                guidelineId: guideline.id,
                guidelineVersion: guideline.guidelineVersion,
                sourceUrl: guideline.provenance.sourceUrl,
                recommendationText: row.recommendationText,
                implication: row.implication ?? null,
              }
            : { status: 'indeterminate', drug, gene: guideline.gene, reasonCode: 'PHENOTYPE_NOT_IN_GUIDELINE' },
        );
      }
    }
  }

  return { knowledgeSetId: knowledge.id, phenotypes, recommendations };
}

function resolvePhenotypes(knowledge: KnowledgeSet, calls: readonly GeneCall[]): PhenotypeResult[] {
  const byGene = new Map<string, GeneCall[]>();
  for (const call of calls) byGene.set(call.gene, [...(byGene.get(call.gene) ?? []), call]);

  const results: PhenotypeResult[] = [];
  for (const gene of [...byGene.keys()].sort(byText)) {
    const geneCalls = byGene.get(gene)!;
    const first = geneCalls[0]!;
    // Two identical calls are one call; two different ones are a conflict we must not resolve by picking.
    if (geneCalls.some((call) => JSON.stringify(call) !== JSON.stringify(first))) {
      results.push({ status: 'indeterminate', gene, reasonCode: 'CONFLICTING_CALLS' });
    } else if (first.outcome === 'indeterminate') {
      results.push({ status: 'indeterminate', gene, reasonCode: first.reasonCode });
    } else {
      const map = knowledge.gene(gene);
      results.push(map ? mapPhenotype(map, first.diplotype) : { status: 'indeterminate', gene, reasonCode: 'NO_GENE_DEFINITION' });
    }
  }
  return results;
}
