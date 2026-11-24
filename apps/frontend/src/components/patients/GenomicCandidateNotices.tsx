import type { CandidateNotice } from '@telesphoros/shared-types';
import { GlossaryTerm } from '@/components/patients/GlossaryTerm';
import { CANDIDATE_WORDS, candidateSentence, GLOSSARY_WORDS } from '@/lib/genomicProfileWords';

/**
 * Spec 045 slice N4: on the drug checked before prescribing, the guidance for this patient that rests on a gene the drug is listed as changing.
 * Everyday words, always shown, in the amber of notices; the source is under "Why, and the evidence". Only on the check (N4-D2).
 */
export function GenomicCandidateNotices({ notices, name }: { notices: readonly CandidateNotice[] | undefined; name: string }) {
  if (!notices || notices.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 rounded-lg bg-warning-surface px-3 py-2 text-sm">
      <p className="font-semibold">{CANDIDATE_WORDS.lead}</p>
      <p>
        <GlossaryTerm text="Phenoconversion" label={GLOSSARY_WORDS.phenoconversion} />
      </p>
      {notices.map((notice) => (
        <p key={notice.gene}>{candidateSentence(notice, name)}</p>
      ))}
    </div>
  );
}
