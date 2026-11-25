import { useCallback, useEffect, useState } from 'react';
import { PatientClinicalSections } from '@/components/patients/PatientClinicalSections';
import { Link, useParams } from 'react-router-dom';
import type { PatientDto } from '@telesphoros/shared-types';
import { SessionEndedError, useAuth } from '@/auth/AuthProvider';
import { CLINICAL_READ_ROLES, WRITER_ROLES } from '@/auth/roles';
import { BackToHomeLink } from '@/components/layout/BackToHomeLink';
import { Breadcrumb } from '@/components/layout/Breadcrumb';
import { DemographicsSection } from '@/components/patients/DemographicsSection';
import { GenomicProfileSection } from '@/components/patients/GenomicProfileSection';
import { IdentityUnknown } from '@/components/patients/IdentityUnknown';
import { MedicationsSection } from '@/components/patients/MedicationsSection';
import { Button } from '@/components/ui/Button';
import { ContentSkeleton } from '@/components/ui/ContentSkeleton';
import { usePageTitle } from '@/hooks/usePageTitle';
import { when } from '@/lib/formatWhen';
import { SubmitError } from '@/lib/api';
import { getDemographics, getPatient, type DemographicsRead } from '@/lib/patientDemographics';
import { failsThePage, IDENTITY_TABLE, RecordingHeldContext } from '@/lib/patientIdentity';
import { useWords } from '@/lib/words/screens';
import { PatientBanner } from '@/components/patients/PatientBanner';
import { PatientLabelContext } from '@/lib/patientLabel';

/** What the page knows about one patient's identity. `unknown`: it could not be read now (docs/design/plans/patient-page-identity-outage.md). */
type Identity = { patientId: string; read: DemographicsRead | { kind: 'unknown' } };

/**
 * Spec 025 T303 (PD-5): one patient's page. Its demographics as recorded now, every earlier version (readable, never overwritten), and for clinicians a
 * form that records a correction as a new version. The page title and the URL carry the synthetic label and the patient id only, never a name or a date
 * of birth; the values exist only in this page's state. Sections are separate so later ones (medications, a later spec) sit beside this one.
 *
 * The patient and its identity are read separately. A failed patient read, and a demographics refusal about this patient (403, 404), stand for the
 * whole page. Any other failure of the identity read leaves the page up with a warning in the banner's place, and holds everything that records
 * something for this patient until the identity is read (B-D1 to B-D3).
 */
export default function PatientPage() {
  const { id = '' } = useParams();
  const { apiFetch, roles } = useAuth();
  const canWrite = roles.some((role) => WRITER_ROLES.includes(role));
  const canReadClinical = roles.some((role) => CLINICAL_READ_ROLES.includes(role));
  const [patient, setPatient] = useState<PatientDto | null>(null);
  // Tagged with the patient it is about, so an answer about one chart is never shown on another while the next one's read is in flight.
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [version, setVersion] = useState<number | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [identityAttempt, setIdentityAttempt] = useState(0);
  const words = useWords(IDENTITY_TABLE);
  // A version number or an error belongs to one patient. Opening another chart (the same page, a new id) starts it at its current record, with its
  // identity banner, and drops the previous patient's error; it is reset here, during render, so the reads below never run with the old values.
  const [shownId, setShownId] = useState(id);
  if (shownId !== id) {
    setShownId(id);
    setVersion(undefined);
    setError(null);
  }
  usePageTitle(patient ? `Patient ${patient.label}` : 'Patient');

  useEffect(() => {
    const controller = new AbortController();
    getPatient(apiFetch, id, controller.signal)
      .then((loaded) => {
        if (!controller.signal.aborted) setPatient(loaded);
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted || caught instanceof SessionEndedError) return;
        setError(caught instanceof SubmitError ? caught.message : 'The patient could not be loaded. Please retry.');
      });
    return () => controller.abort();
  }, [apiFetch, id, attempt]);

  useEffect(() => {
    const controller = new AbortController();
    getDemographics(apiFetch, id, version, controller.signal)
      .then((read) => {
        if (!controller.signal.aborted) setIdentity({ patientId: id, read });
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted || caught instanceof SessionEndedError) return;
        if (failsThePage(caught)) setError(caught.message);
        else setIdentity({ patientId: id, read: { kind: 'unknown' } });
      });
    return () => controller.abort();
  }, [apiFetch, id, version, attempt, identityAttempt]);

  const reload = useCallback(() => {
    setError(null);
    setVersion(undefined);
    setAttempt((n) => n + 1);
  }, []);
  const view = useCallback((next: number | undefined) => {
    setError(null);
    setVersion(next);
  }, []);
  // Reads the identity again, and only it: what the page already shows stays as it is.
  const retryIdentity = useCallback(() => setIdentityAttempt((n) => n + 1), []);

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
            <Link to="/patients">Back to patients</Link>
          </Button>
          <Button asChild variant="ghost" size="sm">
            <Link to="/workspace">Back to home</Link>
          </Button>
        </div>
      </div>
    );
  }
  if (!patient || patient.id !== id || !identity || identity.patientId !== id) {
    return <ContentSkeleton label="Loading patient record…" variant="detail" />;
  }

  const read = identity.read;
  // B-D3: while the identity is unknown, nothing that records something for this patient is offered.
  const held = read.kind === 'unknown';
  const clinical = held ? <p className="max-w-3xl text-sm text-muted-foreground">{words.held}</p> : <PatientClinicalSections key={`clinical-${id}`} patientId={id} />;
  return (
    <PatientLabelContext.Provider value={patient.label}>
      <RecordingHeldContext.Provider value={held}>
        <div className="flex max-w-5xl flex-col gap-6">
          <div className="flex max-w-3xl flex-col gap-6">
            <div className="flex flex-col gap-1">
              <div className="flex flex-wrap items-center justify-between gap-x-4">
                <Breadcrumb trail={[{ to: '/patients', label: 'Patients' }]} current={patient.label} />
                <BackToHomeLink />
              </div>
              <h1 className="text-2xl font-semibold wrap-anywhere">{patient.label}</h1>
              <p className="text-sm text-muted-foreground">Synthetic patient · Added {when(patient.createdAt)}</p>
              {/* The current identity only: while an earlier version is being viewed, the table below is the one place that shows it. */}
              {read.kind === 'found' && version === undefined && <PatientBanner value={read.value} />}
              {held && <IdentityUnknown label={patient.label} onRetry={retryIdentity} />}
            </div>
            {/* Spec 044 slice B (decision B-D1): what the patient's genomic results mean for their medications comes first, under the banner. */}
            {canReadClinical && <GenomicProfileSection key={`genomic-${id}`} patientId={id} />}
            <DemographicsSection patientId={id} read={read} version={version} canWrite={canWrite} onViewVersion={view} onSaved={reload} />
            <MedicationsSection key={id} patientId={id} canWrite={roles.includes('clinician') && !held} />
          </div>
          {/* Wider than the record above it, so a result's evidence can sit beside the result (specs/038 D7). */}
          {(roles.includes('clinician') || roles.includes('reviewer')) && clinical}
        </div>
      </RecordingHeldContext.Provider>
    </PatientLabelContext.Provider>
  );
}
