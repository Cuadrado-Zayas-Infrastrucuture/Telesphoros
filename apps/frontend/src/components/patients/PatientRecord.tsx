import { useEffect, useState } from 'react';
import { PatientClinicalSections } from '@/components/patients/PatientClinicalSections';
import { Link } from 'react-router-dom';
import type { PatientDto } from '@telesphoros/shared-types';
import { SessionEndedError, useAuth } from '@/auth/AuthProvider';
import { WRITER_ROLES } from '@/auth/roles';
import { PatientDemographicsSection } from '@/components/patients/PatientDemographicsSection';
import { MedicationsSection } from '@/components/patients/MedicationsSection';
import { Button } from '@/components/ui/Button';
import { ContentSkeleton } from '@/components/ui/ContentSkeleton';
import { usePageTitle } from '@/hooks/usePageTitle';
import { when } from '@/lib/formatWhen';
import { SubmitError } from '@/lib/api';
import { getPatient } from '@/lib/patientDemographics';

/**
 * Spec 025 T303 (PD-5): one patient's page. Its demographics as recorded now, every earlier version (readable, never overwritten), and for clinicians a
 * form that records a correction as a new version. The page title and the URL carry the synthetic label and the patient id only, never a name or a date
 * of birth; the values exist only in this page's state. Sections are separate so later ones (medications, a later spec) sit beside this one.
 */
export function PatientRecord({ id }: { id: string }) {
  const { apiFetch, roles } = useAuth();
  const canWrite = roles.some((role) => WRITER_ROLES.includes(role));
  const [patient, setPatient] = useState<PatientDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  usePageTitle(patient ? `Patient ${patient.label}` : 'Patient');

  useEffect(() => {
    const controller = new AbortController();
    getPatient(apiFetch, id, controller.signal)
      .then((loadedPatient) => {
        if (controller.signal.aborted) return;
        if (loadedPatient.id !== id) throw new SubmitError('The patient could not be loaded. Please retry.');
        setPatient(loadedPatient);
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted || caught instanceof SessionEndedError) return;
        setError(caught instanceof SubmitError ? caught.message : 'The patient could not be loaded. Please retry.');
      });
    return () => controller.abort();
  }, [apiFetch, id, attempt]);

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
            <Link to="/workspace">Back to chat</Link>
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex max-w-3xl flex-col gap-6">
      {patient ? (
        <div className="flex flex-col gap-1">
          <Link to="/workspace" className="inline-flex min-h-control items-center text-sm text-muted-foreground underline-offset-2 hover:underline">
            Back to chat
          </Link>
          <h1 className="text-2xl font-semibold wrap-anywhere">{patient.label}</h1>
          <p className="text-sm text-muted-foreground">Synthetic patient, added {when(patient.createdAt)}.</p>
        </div>
      ) : (
        <ContentSkeleton label="Loading patient record…" variant="detail" />
      )}
      {/* Start independent reads together, but reveal no section or write control until identity is confirmed. */}
      <div hidden={!patient} className={patient ? 'flex flex-col gap-6' : undefined}>
        <PatientDemographicsSection patientId={id} canWrite={canWrite} />
        <MedicationsSection patientId={id} canWrite={roles.includes('clinician')} />
        {patient && (roles.includes('clinician') || roles.includes('reviewer')) && <PatientClinicalSections patientId={id} />}
      </div>
    </div>
  );
}
