import { useId, useState } from 'react';
import type { GenomicCheck, GenomicGene } from '@telesphoros/shared-types';
import { GenomicCheckLayerOne } from '@/components/patients/GenomicCheckLayerOne';
import { GenomicContextNotices } from '@/components/patients/GenomicContextNotices';
import { GenomicNoticeEvidence } from '@/components/patients/GenomicNoticeEvidence';
import { GenomicResultLayers } from '@/components/patients/GenomicResultLayers';
import { GlossaryTerm } from '@/components/patients/GlossaryTerm';
import { Button } from '@/components/ui/Button';
import { checkSentence, conflictLine, PROFILE_WORDS, WORD_LABELS } from '@/lib/genomicProfileWords';
import { showsWording } from '@/lib/resultStatus';

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
 * the gene it rests on, then any notice that a medication this patient takes can change that gene's effect (spec 045 N3). Layers 2 (why)
 * and 3 (the evidence, with each notice's source) open together.
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
      <p className={`font-semibold ${WORD_TONE[check.word]}`}>
        <GlossaryTerm text={WORD_LABELS[check.word]} />
      </p>
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
        <GenomicCheckLayerOne key={result.resultId} result={result} genes={genes} />
      ))}
      <GenomicContextNotices notices={check.contextNotices} place="row" checkRxcui={check.rxcui} />
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
            <GenomicResultLayers key={result.resultId} result={result} genes={genes} knowledgeChanged={check.knowledgeChanged} />
          ))}
          <GenomicNoticeEvidence notices={check.contextNotices} />
        </div>
      )}
    </article>
  );
}
