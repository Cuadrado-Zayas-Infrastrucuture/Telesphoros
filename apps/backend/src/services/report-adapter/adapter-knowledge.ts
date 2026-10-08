import type { KnowledgeSet } from '../knowledge/knowledge-set';
import { mapPhenotype } from '../phenotype-engine/phenotype-engine';

/**
 * The only things the adapter asks of the knowledge: a gene's own canonical phenotype terms, and whether a diplotype can be
 * turned into a phenotype. It never decides what either means: the engine's own mapper does.
 */
export interface AdapterKnowledge {
  /** The gene's canonical phenotype terms, or null when the knowledge has no definition for the gene. */
  canonicalPhenotypes(gene: string): readonly string[] | null;
  mapDiplotype(gene: string, diplotype: string): { mapped: true; phenotype: string } | { mapped: false };
}

export function adapterKnowledgeFrom(knowledge: KnowledgeSet): AdapterKnowledge {
  return {
    canonicalPhenotypes: (gene) => knowledge.gene(gene)?.phenotypes ?? null,
    mapDiplotype: (gene, diplotype) => {
      const map = knowledge.gene(gene);
      if (!map) return { mapped: false };
      const mapping = mapPhenotype(map, diplotype);
      return mapping.status === 'determined' ? { mapped: true, phenotype: mapping.phenotype } : { mapped: false };
    },
  };
}
