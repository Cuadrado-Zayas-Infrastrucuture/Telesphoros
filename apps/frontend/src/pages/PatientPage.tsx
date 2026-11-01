import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { PatientDto } from '@telesphoros/shared-types';
import { SessionEndedError, useAuth } from '@/auth/AuthProvider';
import { WRITER_ROLES } from '@/auth/roles';
import { DemographicsSection } from '@/components/patients/DemographicsSection';
import { MedicationsSection } from '@/components/patients/MedicationsSection';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { usePageTitle } from '@/hooks/usePageTitle';
import { when } from '@/lib/formatWhen';
import { SubmitError } from '@/lib/api';
import { getDemographics, getPatient, type DemographicsRead } from '@/lib/patientDemographics';

/**
 * Spec 025 T303 (PD-5): one patient's page. Its demographics as recorded now, every earlier version (readable, never overwritten), and for clinicians a
 * form that records a correction as a new version. The page title and the URL carry the synthetic label and the patient id only, never a name or a date
 * of birth; the values exist only in this page's state. Sections are separate so later ones (medications, a later spec) sit beside this one.
 */
export default function PatientPage() {
  const { id = '' } = useParams();
  const { apiFetch, roles } = useAuth();
  const canWrite = roles.some((role) => WRITER_ROLES.includes(role));
  const [patient, setPatient] = useState<PatientDto | null>(null);
  const [read, setRead] = useState<DemographicsRead | null>(null);
  const [version, setVersion] = useState<number | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  usePageTitle(patient ? `Patient ${patient.label}` : 'Patient');

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([getPatient(apiFetch, id, controller.signal), getDemographics(apiFetch, id, version, controller.signal)])
      .then(([loadedPatient, loadedRead]) => {
        if (controller.signal.aborted) return;
        setPatient(loadedPatient);
        setRead(loadedRead);
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted || caught instanceof SessionEndedError) return;
        setError(caught instanceof SubmitError ? caught.message : 'The patient could not be loaded. Please retry.');
      });
    return () => controller.abort();
  }, [apiFetch, id, version, attempt]);

  const reload = useCallback(() => {
    setError(null);
    setVersion(undefined);
    setAttempt((n) => n + 1);
  }, []);
  const view = useCallback((next: number | undefined) => {
    setError(null);
    setVersion(next);
  }, []);

  if (error) {
    return (
      <div className="flex flex-col items-start gap-3">
        <h1 className="text-2xl font-semibold">Patient</h1>
        <p role="alert" className="text-destructive">
          {error}
        </p>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setError(null);
              setAttempt((n) => n + 1);
            }}
          >
            Retry
          </Button>
          <Button asChild variant="ghost" size="sm">
            <Link to="/workspace">Back to the workspace</Link>
          </Button>
        </div>
      </div>
    );
  }
  if (!patient || patient.id !== id || !read) {
    return (
      <div className="flex flex-col gap-3" aria-busy="true">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <div className="flex flex-col gap-1">
        <Link to="/workspace" className="text-sm text-muted-foreground underline-offset-2 hover:underline">
          Workspace
        </Link>
        <h1 className="text-2xl font-semibold wrap-anywhere">{patient.label}</h1>
        <p className="text-sm text-muted-foreground">Synthetic patient, added {when(patient.createdAt)}.</p>
      </div>
      <DemographicsSection patientId={id} read={read} version={version} canWrite={canWrite} onViewVersion={view} onSaved={reload} />
      <MedicationsSection key={id} patientId={id} canWrite={roles.includes('clinician')} />
    </div>
  );
}
