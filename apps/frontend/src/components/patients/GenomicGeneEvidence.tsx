import type { GenomicGene } from '@telesphoros/shared-types';
import { when } from '@/lib/formatWhen';
import { PROFILE_WORDS } from '@/lib/genomicProfileWords';

/** What one report says about the gene: phenotype as reported, diplotype as printed, activity score; or that it could not be resolved. */
function sourceText(source: GenomicGene['sources'][number]): string {
  const parts = [source.phenotype, source.diplotype, source.activityScore === null ? null : `activity score ${source.activityScore}`];
  return parts.filter((part): part is string => part !== null).join(' · ') || PROFILE_WORDS.notResolved;
}

/** The gene as each confirmed report gives it: phenotype as reported, diplotype as printed, the report's date. */
export function GenomicGeneEvidence({ name, gene }: { name: string; gene: GenomicGene | undefined }) {
  return (
    <>
      <dt className="text-muted-foreground">{name}</dt>
      <dd className="flex flex-col gap-0.5 sm:col-span-2">
        {gene ? (
          gene.sources.map((source) => (
            <span key={source.evaluationId}>
              {sourceText(source)} (evaluated {when(source.evaluatedAt)}; {PROFILE_WORDS.confirmed.toLowerCase()})
            </span>
          ))
        ) : (
          <span>{PROFILE_WORDS.notTested}</span>
        )}
      </dd>
    </>
  );
}
