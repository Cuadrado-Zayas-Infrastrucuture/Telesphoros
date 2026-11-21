import { useEffect, useState } from 'react';
import type { GenomicCheck, GenomicGene, GenomicProfileDto } from '@telesphoros/shared-types';
import { BUNDLED_DRUG_LIST } from '@telesphoros/shared-types/drug-list-data';
import { SessionEndedError, useAuth } from '@/auth/AuthProvider';
import { DrugPicker } from '@/components/patients/DrugPicker';
import { GenomicCheckRow } from '@/components/patients/GenomicCheckRow';
import { Button } from '@/components/ui/Button';
import { ContentSkeleton } from '@/components/ui/ContentSkeleton';
import { when } from '@/lib/formatWhen';
import { readGenomicProfile, type GenomicProfileRead } from '@/lib/genomicProfile';
import { awaitingLine, geneValue, PROFILE_WORDS, summaryLine, untestedGenes } from '@/lib/genomicProfileWords';

/** Combination products are checked only as the combination (spec 039 D2, slice B decision B-D2); the bundled list knows which they are. */
const isCombination = (rxcui: string) => BUNDLED_DRUG_LIST?.entries.find((entry) => entry.rxcui === rxcui)?.tty === 'MIN';
const drugName = (rxcui: string) => BUNDLED_DRUG_LIST?.entries.find((entry) => entry.rxcui === rxcui)?.displayName ?? null;

/**
 * Spec 044 slice B: the patient's genomic profile and medication check, under the patient banner. In this order (decision B-D1): one summary
 * line, a notice while a report waits for its patient link to be confirmed, the current medications checked, a drug checked before it is
 * prescribed, and the genomic profile itself. Every part answers in place when the route is not served (503) or fails, and the rest of the
 * patient page keeps working. Reads only: nothing on this screen is saved.
 */
export function GenomicProfileSection({ patientId }: { patientId: string }) {
  const { apiFetch } = useAuth();
  const [read, setRead] = useState<GenomicProfileRead | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    readGenomicProfile(apiFetch, patientId, undefined, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setRead(result);
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted || caught instanceof SessionEndedError) return;
        setFailed(true);
      });
    return () => controller.abort();
  }, [apiFetch, patientId, attempt]);
  return (
    <section aria-labelledby="genomic-profile-heading" className="flex flex-col gap-4 border-t border-border pt-6">
      <div className="flex flex-col gap-1">
        <h2 id="genomic-profile-heading" className="text-lg font-semibold">
          {PROFILE_WORDS.heading}
        </h2>
        <p className="text-sm text-muted-foreground">{PROFILE_WORDS.intro}</p>
      </div>
      {failed ? (
        <div className="flex flex-col items-start gap-2">
          <p role="alert" className="text-destructive">
            {PROFILE_WORDS.failed}
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setFailed(false);
              setRead(null);
              setAttempt((n) => n + 1);
            }}
          >
            {PROFILE_WORDS.retry}
          </Button>
        </div>
      ) : read === null ? (
        <ContentSkeleton label={PROFILE_WORDS.loading} variant="detail" />
      ) : read.kind === 'unavailable' ? (
        <p>{PROFILE_WORDS.unavailable}</p>
      ) : (
        <ProfileBody profile={read.profile} patientId={patientId} />
      )}
    </section>
  );
}

function ProfileBody({ profile, patientId }: { profile: GenomicProfileDto; patientId: string }) {
  const awaiting = awaitingLine(profile.awaitingLinkReview.length);
  return (
    <div className="flex flex-col gap-6">
      <p className="rounded-lg bg-muted px-3 py-2 font-medium">{summaryLine(profile)}</p>
      {awaiting && (
        <p role="status" className="rounded-lg bg-warning-surface px-3 py-2 text-sm">
          {awaiting}
        </p>
      )}
      {profile.capped && <p className="text-sm font-medium text-warning">{PROFILE_WORDS.capped}</p>}
      <div className="flex flex-col gap-3">
        <h3 id="genomic-medications-heading" className="font-semibold">
          {PROFILE_WORDS.medicationsHeading}
        </h3>
        {profile.medications.length === 0 ? (
          <p className="text-sm">{PROFILE_WORDS.noMedications}</p>
        ) : (
          profile.medications.map((check, index) => (
            <GenomicCheckRow
              key={`${check.rxcui}-${index}`}
              check={check}
              name={check.name ?? drugName(check.rxcui) ?? check.rxcui}
              genes={profile.genes}
              combination={isCombination(check.rxcui)}
            />
          ))
        )}
      </div>
      <DrugCheck patientId={patientId} />
      <GeneCards genes={profile.genes} untested={untestedGenes(profile)} />
    </div>
  );
}

type CheckAnswer = { check: GenomicCheck; genes: GenomicGene[] } | 'unavailable' | 'failed';

/** A drug checked before it is prescribed: the same row as a medication's, read with `?rxcui=`. Nothing is saved. */
function DrugCheck({ patientId }: { patientId: string }) {
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

/** One card per gene: the phenotype in words, each confirmed report and its date; and "Not tested" for a gene a guideline needs that none includes. */
function GeneCards({ genes, untested }: { genes: readonly GenomicGene[]; untested: readonly string[] }) {
  return (
    <div className="flex flex-col gap-3">
      <h3 id="genomic-genes-heading" className="font-semibold">
        {PROFILE_WORDS.genesHeading}
      </h3>
      {genes.length === 0 && untested.length === 0 && <p className="text-sm">{PROFILE_WORDS.noGenes}</p>}
      <ul className="grid gap-3 sm:grid-cols-2">
        {genes.map((gene) => (
          <li key={gene.gene} className="flex flex-col gap-1 rounded-lg border border-border bg-panel p-4">
            <h4 className="font-semibold">{gene.gene}</h4>
            <p className={gene.status === 'conflict' ? 'font-medium text-warning' : 'font-medium'}>{geneStatusText(gene)}</p>
            {gene.sources.map((source) => (
              <p key={source.evaluationId} className="text-sm text-muted-foreground">
                Evaluated {when(source.evaluatedAt)}. {PROFILE_WORDS.confirmed}.
              </p>
            ))}
          </li>
        ))}
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
