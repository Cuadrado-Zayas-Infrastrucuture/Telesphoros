import type { GenomicCheckResult, GenomicGene } from '@telesphoros/shared-types';
import { becauseLine } from '@/lib/genomicProfileWords';

/** Layer 1 for one result whose wording comes from a verified cell: the recommendation quoted, its strength, and the gene it rests on. */
export function GenomicCheckLayerOne({ result, genes }: { result: GenomicCheckResult; genes: readonly GenomicGene[] }) {
  const because = becauseLine(result, genes);
  return (
    <div className="flex flex-col gap-1">
      {result.recommendationText && <blockquote className="rounded-md bg-muted px-3 py-2 whitespace-pre-line">{result.recommendationText}</blockquote>}
      {result.strength && <p className="text-sm">Strength: {result.strength}</p>}
      {because && <p className="text-sm">{because}</p>}
    </div>
  );
}
