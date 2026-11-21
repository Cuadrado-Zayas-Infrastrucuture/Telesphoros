import { useId, useState } from 'react';
import type { GenomicCheck, GenomicCheckResult, GenomicGene } from '@telesphoros/shared-types';
import { Button } from '@/components/ui/Button';
import { citationView } from '@/lib/citationView';
import { when } from '@/lib/formatWhen';
import { becauseLine, checkSentence, conflictLine, PROFILE_WORDS, WORD_LABELS } from '@/lib/genomicProfileWords';
import { outcomeLabel, showsWording } from '@/lib/resultStatus';

const WORD_TONE: Readonly<Record<GenomicCheck['word'], string>> = {
  // The action teal for guidance to act on; the amber of notices for Held; never the signal tangerine, and never colour alone.
  review: 'text-primary',
  held: 'text-warning',
  'no-recommendation': '',
  'no-guideline-loaded': '',
};

/**
 * One medication, or one drug checked before prescribing, in three layers (spec 044 slice B, section 4). Layer 1 is always shown: the drug,
 * its word, the sentence that word carries and, where a verified cell gives one, CPIC's recommendation quoted exactly with its strength and
 * the gene it rests on. Layers 2 (why) and 3 (the evidence) open together.
 */
export function GenomicCheckRow({ check, name, genes, combination }: { check: GenomicCheck; name: string; genes: readonly GenomicGene[]; combination: boolean }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const sentence = checkSentence(check);
  const conflict = conflictLine(check, genes);
  return (
    <article aria-labelledby={`${id}-name`} className="flex flex-col gap-2 rounded-lg border border-border bg-panel p-4">
      <h4 id={`${id}-name`} className="text-base font-semibold wrap-anywhere">
        {name}
      </h4>
      <p className={`font-semibold ${WORD_TONE[check.word]}`}>{WORD_LABELS[check.word]}</p>
      {sentence && (
        <p className="text-sm text-muted-foreground">
          {sentence.message}
          {sentence.nextStep && ` ${sentence.nextStep}`}
        </p>
      )}
      {combination && <p className="text-sm">{PROFILE_WORDS.combination}</p>}
      {check.knowledgeChanged && <p className="text-sm font-medium text-warning">{PROFILE_WORDS.knowledgeChanged}</p>}
      {conflict && <p className="text-sm font-medium text-warning">{conflict}</p>}
      {check.results.filter(showsWording).map((result) => (
        <LayerOne key={result.resultId} result={result} genes={genes} />
      ))}
      {check.results.length > 0 && (
        <div>
          <Button variant="outline" size="sm" aria-expanded={open} aria-controls={`${id}-layers`} onClick={() => setOpen((value) => !value)}>
            {open ? PROFILE_WORDS.close : PROFILE_WORDS.open}
          </Button>
        </div>
      )}
      {open && (
        <div id={`${id}-layers`} className="flex flex-col gap-4 border-t border-border pt-3">
          {check.results.map((result) => (
            <ResultLayers key={result.resultId} result={result} genes={genes} knowledgeChanged={check.knowledgeChanged} />
          ))}
        </div>
      )}
    </article>
  );
}

/** Layer 1 for one result whose wording comes from a verified cell: the recommendation quoted, its strength, and the gene it rests on. */
function LayerOne({ result, genes }: { result: GenomicCheckResult; genes: readonly GenomicGene[] }) {
  const because = becauseLine(result, genes);
  return (
    <div className="flex flex-col gap-1">
      {result.recommendationText && <blockquote className="rounded-md bg-muted px-3 py-2 whitespace-pre-line">{result.recommendationText}</blockquote>}
      {result.strength && <p className="text-sm">Strength: {result.strength}</p>}
      {because && <p className="text-sm">{because}</p>}
    </div>
  );
}

/** Layers 2 and 3 for one matching result. Every matching result is listed, so a held result beside a shown one is visible (P1). */
function ResultLayers({ result, genes, knowledgeChanged }: { result: GenomicCheckResult; genes: readonly GenomicGene[]; knowledgeChanged: boolean }) {
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
            <GeneEvidence key={name} name={name} gene={genes.find((gene) => gene.gene === name)} />
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
    </div>
  );
}

/** What one report says about the gene: phenotype as reported, diplotype as printed, activity score; or that it could not be resolved. */
function sourceText(source: GenomicGene['sources'][number]): string {
  const parts = [source.phenotype, source.diplotype, source.activityScore === null ? null : `activity score ${source.activityScore}`];
  return parts.filter((part): part is string => part !== null).join(' · ') || PROFILE_WORDS.notResolved;
}

/** The gene as each confirmed report gives it: phenotype as reported, diplotype as printed, the report's date. */
function GeneEvidence({ name, gene }: { name: string; gene: GenomicGene | undefined }) {
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
