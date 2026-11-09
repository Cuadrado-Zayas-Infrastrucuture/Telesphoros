import { useEffect, useState } from 'react';
import { SessionEndedError, useAuth } from '@/auth/AuthProvider';
import { DemographicsSection } from '@/components/patients/DemographicsSection';
import { Button } from '@/components/ui/Button';
import { ContentSkeleton } from '@/components/ui/ContentSkeleton';
import { SubmitError } from '@/lib/api';
import { getDemographics, type DemographicsRead } from '@/lib/patientDemographics';

/** Demographics owns its loading, version and retry; neither a slow read nor a refusal hides medication state. */
export function PatientDemographicsSection({ patientId, canWrite }: { patientId: string; canWrite: boolean }) {
  const { apiFetch } = useAuth();
  const [read, setRead] = useState<DemographicsRead | null>(null);
  const [version, setVersion] = useState<number | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    getDemographics(apiFetch, patientId, version, controller.signal)
      .then((loaded) => {
        if (controller.signal.aborted) return;
        if (loaded.kind === 'found' && loaded.value.patientId !== patientId) throw new SubmitError('The demographics could not be loaded. Please retry.');
        setRead(loaded);
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted || caught instanceof SessionEndedError) return;
        setError(caught instanceof SubmitError ? caught.message : 'The demographics could not be loaded. Please retry.');
      });
    return () => controller.abort();
  }, [apiFetch, patientId, version, attempt]);

  if (error || !read)
    return (
      <section aria-labelledby="demographics-heading" className="flex flex-col gap-4">
        <h2 id="demographics-heading" className="text-lg font-semibold">
          Demographics
        </h2>
        {error ? (
          <>
            <p role="alert" className="text-destructive">
              {error}
            </p>
            <div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setError(null);
                  setAttempt((n) => n + 1);
                }}
              >
                Retry demographics
              </Button>
            </div>
          </>
        ) : (
          <ContentSkeleton label="Loading demographics…" variant="detail" />
        )}
      </section>
    );
  return (
    <DemographicsSection
      patientId={patientId}
      read={read}
      version={version}
      canWrite={canWrite}
      onViewVersion={(next) => {
        setError(null);
        setVersion(next);
      }}
      onSaved={() => {
        setError(null);
        setVersion(undefined);
        setAttempt((n) => n + 1);
      }}
    />
  );
}
