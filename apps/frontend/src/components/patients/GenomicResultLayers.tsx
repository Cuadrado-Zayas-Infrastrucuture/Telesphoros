import type { GenomicCheckResult, GenomicGene } from '@telesphoros/shared-types';
import { GenomicDecisionControl } from '@/components/patients/GenomicDecisionControl';
import { GenomicGeneEvidence } from '@/components/patients/GenomicGeneEvidence';
import { citationView } from '@/lib/citationView';
import { PROFILE_WORDS } from '@/lib/genomicProfileWords';
import { outcomeLabel } from '@/lib/resultStatus';

/**
 * Layers 2 and 3 for one matching result. Every matching result is listed, so a held result beside a shown one is visible (P1). Under the
 * evidence, "Record a decision" (spec 044 D9, B2-D4).
 */
export function GenomicResultLayers({ result, genes, knowledgeChanged }: { result: GenomicCheckResult; genes: readonly GenomicGene[]; knowledgeChanged: boolean }) {
  const citation = citationView(result.citation);
  const guideline = citation?.guideline ? `${citation.guideline}${citation.version ? `, version ${citation.version}` : ''}` : null;
  const location = citation?.location ? [citation.location.table, citation.location.row, citation.location.column].filter(Boolean).join(', ') : null;
  return (
    <div className="flex flex-col gap-3">
      <p className="font-medium">{outcomeLabel(result.outcome)}</p>
      <section className="flex flex-col gap-1">
        <h5 className="text-sm font-semibold">{PROFILE_WORDS.whyHeading}</h5>
        {result.implication ? <blockquote className="text-sm whitespace-pre-line">{result.implication}</blockquote> : <p className="text-sm">{PROFILE_WORDS.noImplication}</p>}
      </section>
      <section className="flex flex-col gap-1">
        <h5 className="text-sm font-semibold">{PROFILE_WORDS.evidenceHeading}</h5>
        <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
          {result.genes.map((name) => (
            <GenomicGeneEvidence key={name} name={name} gene={genes.find((gene) => gene.gene === name)} />
          ))}
          <dt className="text-muted-foreground">Guideline</dt>
          <dd className="wrap-anywhere sm:col-span-2">{guideline ?? 'Not recorded'}</dd>
          <dt className="text-muted-foreground">Table and row</dt>
          <dd className="sm:col-span-2">{location || 'Not recorded'}</dd>
          {citation?.verification && (
            <>
              <dt className="text-muted-foreground">Cell</dt>
              <dd className={`sm:col-span-2 ${citation.verification.caution ? 'text-warning' : ''}`}>{citation.verification.word}</dd>
            </>
          )}
          <dt className="text-muted-foreground">Signed by</dt>
          <dd className="sm:col-span-2">{citation && citation.signedBy.length > 0 ? citation.signedBy.join(', ') : 'Not recorded'}</dd>
          <dt className="text-muted-foreground">Guidelines changed since?</dt>
          <dd className="sm:col-span-2">{knowledgeChanged ? 'Yes' : 'No'}</dd>
        </dl>
        {citation?.sourceUrl && (
          <a className="text-sm underline" href={citation.sourceUrl} target="_blank" rel="noreferrer">
            The published guideline
          </a>
        )}
      </section>
      <GenomicDecisionControl resultId={result.resultId} />
    </div>
  );
}
