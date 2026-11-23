import type { ContextNotice } from '@telesphoros/shared-types';
import { GlossaryTerm } from '@/components/patients/GlossaryTerm';
import { GLOSSARY_WORDS, NOTICE_WORDS, noticeSentence, noticeSourceLine } from '@/lib/genomicProfileWords';

/**
 * Spec 045 slice N3: the notices that a medication this patient takes can change a gene's effect, in everyday words, on a medication's row
 * or a gene's card. Always shown, never behind a button, in the amber of notices (D9). A gene's card has no opened layer, so it gives each
 * notice's source on the line under it; a row gives it under "Why, and the evidence".
 */
export function GenomicContextNotices({ notices, place, checkRxcui }: { notices: readonly ContextNotice[] | undefined; place: 'row' | 'card'; checkRxcui?: string }) {
  if (!notices || notices.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 rounded-lg bg-warning-surface px-3 py-2 text-sm">
      <p className="font-semibold">{NOTICE_WORDS.lead}</p>
      <p>
        <GlossaryTerm text="Phenoconversion" label={GLOSSARY_WORDS.phenoconversion} />
      </p>
      {notices.map((notice) => (
        <div key={`${notice.gene}-${notice.medication.rxcui}`} className="flex flex-col gap-1">
          <p>{noticeSentence(notice, place, checkRxcui)}</p>
          {place === 'card' && <p>{noticeSourceLine(notice)}</p>}
        </div>
      ))}
    </div>
  );
}
