import { useEffect, useState } from 'react';
import { SessionEndedError, useAuth } from '@/auth/AuthProvider';
import { GenomicGlossary } from '@/components/patients/GenomicGlossary';
import { GenomicProfileBody } from '@/components/patients/GenomicProfileBody';
import { GlossaryListButton } from '@/components/patients/GlossaryListButton';
import { Button } from '@/components/ui/Button';
import { ContentSkeleton } from '@/components/ui/ContentSkeleton';
import { readGenomicProfile, type GenomicProfileRead } from '@/lib/genomicProfile';
import { PROFILE_WORDS } from '@/lib/genomicProfileWords';

/**
 * Spec 044 slice B: the patient's genomic profile and medication check, under the patient banner. In this order (decision B-D1): one summary
 * line, a notice while a report waits for its patient link to be confirmed, the current medications checked, a drug checked before it is
 * prescribed, and the genomic profile itself. Every part answers in place when the route is not served (503) or fails, and the rest of the
 * patient page keeps working. Reads only: nothing on this screen is saved. Its words open a glossary in the side drawer (slice B part 2).
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
      <GenomicGlossary>
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-1">
            <h2 id="genomic-profile-heading" className="text-lg font-semibold">
              {PROFILE_WORDS.heading}
            </h2>
            <GlossaryListButton />
          </div>
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
          <GenomicProfileBody profile={read.profile} patientId={patientId} />
        )}
      </GenomicGlossary>
    </section>
  );
}
