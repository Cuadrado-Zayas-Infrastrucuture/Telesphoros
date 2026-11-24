import type { GenomicGene } from '@telesphoros/shared-types';
import { GenomicContextNotices } from '@/components/patients/GenomicContextNotices';
import { GlossaryTerm } from '@/components/patients/GlossaryTerm';
import { when } from '@/lib/formatWhen';
import { geneValue, PROFILE_WORDS } from '@/lib/genomicProfileWords';

/**
 * One card per gene: the phenotype in words (opening its glossary entry when it has one), each confirmed report and its date; and "Not
 * tested" for a gene a guideline needs that none includes.
 */
export function GenomicGeneCards({ genes, untested }: { genes: readonly GenomicGene[]; untested: readonly string[] }) {
  return (
    <div className="flex flex-col gap-3">
      <h3 id="genomic-genes-heading" className="font-semibold">
        {PROFILE_WORDS.genesHeading}
      </h3>
      {genes.length === 0 && untested.length === 0 && <p className="text-sm">{PROFILE_WORDS.noGenes}</p>}
      <ul className="grid gap-3 sm:grid-cols-2">
        {genes.map((gene) => {
          const value = geneValue(gene);
          return (
            <li key={gene.gene} className="flex flex-col gap-1 rounded-lg border border-border bg-panel p-4">
              <h4 className="font-semibold">{gene.gene}</h4>
              <p className={gene.status === 'conflict' ? 'font-medium text-warning' : 'font-medium'}>{value ? <GlossaryTerm text={value} /> : geneStatusText(gene)}</p>
              {gene.sources.map((source) => (
                <p key={source.evaluationId} className="text-sm text-muted-foreground">
                  Evaluated {when(source.evaluatedAt)}. {PROFILE_WORDS.confirmed}.
                </p>
              ))}
              <GenomicContextNotices notices={gene.contextNotices} place="card" />
            </li>
          );
        })}
        {untested.map((name) => (
          <li key={name} className="flex flex-col gap-1 rounded-lg border border-border bg-panel p-4">
            <h4 className="font-semibold">{name}</h4>
            <p className="font-medium">{PROFILE_WORDS.notTested}</p>
            <p className="text-sm text-muted-foreground">{PROFILE_WORDS.notTestedDetail}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

function geneStatusText(gene: GenomicGene): string {
  if (gene.status === 'conflict') return 'Two reports disagree. Both are shown under the evidence of each medication that uses this gene.';
  return geneValue(gene) ?? PROFILE_WORDS.notResolved;
}
