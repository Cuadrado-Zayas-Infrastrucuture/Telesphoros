import { useEffect, useState } from 'react';
import type { GenomicCheck, GenomicGene } from '@telesphoros/shared-types';
import { SessionEndedError, useAuth } from '@/auth/AuthProvider';
import { DrugPicker } from '@/components/patients/DrugPicker';
import { GenomicCheckRow } from '@/components/patients/GenomicCheckRow';
import { drugName, isCombination } from '@/lib/genomicProfileDrugs';
import { readGenomicProfile } from '@/lib/genomicProfile';
import { PROFILE_WORDS } from '@/lib/genomicProfileWords';

type CheckAnswer = { check: GenomicCheck; genes: GenomicGene[] } | 'unavailable' | 'failed';

/** A drug checked before it is prescribed: the same row as a medication's, read with `?rxcui=`. Nothing is saved. */
export function GenomicDrugCheck({ patientId }: { patientId: string }) {
  const { apiFetch } = useAuth();
  const [rxcui, setRxcui] = useState('');
  // Each answer is kept with the drug it is for, so an answer for an earlier choice is never shown for the drug chosen now.
  const [answer, setAnswer] = useState<{ rxcui: string; value: CheckAnswer } | null>(null);
  useEffect(() => {
    if (!rxcui) return;
    const controller = new AbortController();
    readGenomicProfile(apiFetch, patientId, rxcui, controller.signal)
      .then((read) => {
        if (controller.signal.aborted) return;
        const value: CheckAnswer = read.kind === 'unavailable' || !read.profile.check ? 'unavailable' : { check: read.profile.check, genes: read.profile.genes };
        setAnswer({ rxcui, value });
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted || caught instanceof SessionEndedError) return;
        setAnswer({ rxcui, value: 'failed' });
      });
    return () => controller.abort();
  }, [apiFetch, patientId, rxcui]);
  const result: CheckAnswer | 'checking' | null = !rxcui ? null : answer?.rxcui === rxcui ? answer.value : 'checking';
  return (
    <div className="flex flex-col gap-3">
      <h3 id="genomic-check-heading" className="font-semibold">
        {PROFILE_WORDS.checkHeading}
      </h3>
      <DrugPicker value={rxcui} disabled={false} onChange={setRxcui} />
      <p className="text-sm text-muted-foreground">{PROFILE_WORDS.checkNothingSaved}</p>
      {result === 'checking' && <p role="status">{PROFILE_WORDS.checkChecking}</p>}
      {result === 'unavailable' && <p>{PROFILE_WORDS.unavailable}</p>}
      {result === 'failed' && (
        <p role="alert" className="text-destructive">
          {PROFILE_WORDS.failed}
        </p>
      )}
      {result !== null && typeof result === 'object' && (
        <GenomicCheckRow check={result.check} name={drugName(rxcui) ?? rxcui} genes={result.genes} combination={isCombination(rxcui)} />
      )}
    </div>
  );
}
