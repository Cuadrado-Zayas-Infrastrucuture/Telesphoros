import { Fragment } from 'react';
import type { GenomicCheckResult, GenomicGene } from '@telesphoros/shared-types';
import { GlossaryTerm } from '@/components/patients/GlossaryTerm';
import { becauseClauses } from '@/lib/genomicProfileWords';

/**
 * Layer 1 for one result whose wording comes from a verified cell: the recommendation quoted, its strength, and the gene it rests on. The
 * gene's value opens its glossary entry when it has one (spec 044 slice B part 2).
 */
export function GenomicCheckLayerOne({ result, genes }: { result: GenomicCheckResult; genes: readonly GenomicGene[] }) {
  const clauses = becauseClauses(result, genes);
  return (
    <div className="flex flex-col gap-1">
      {result.recommendationText && <blockquote className="rounded-md bg-muted px-3 py-2 whitespace-pre-line">{result.recommendationText}</blockquote>}
      {result.strength && <p className="text-sm">Strength: {result.strength}</p>}
      {clauses.length > 0 && (
        <p className="text-sm">
          {'Because '}
          {clauses.map((clause, index) => (
            <Fragment key={clause.gene}>
              {index > 0 && ' and '}
              {`${clause.gene} is `}
              <GlossaryTerm text={clause.value} />
            </Fragment>
          ))}
          {" in this patient's report."}
        </p>
      )}
    </div>
  );
}
