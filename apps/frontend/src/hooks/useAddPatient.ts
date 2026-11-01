import { useRef, useState } from 'react';
import { patientLabelSchema, type PatientDto } from '@telesphoros/shared-types';
import { SessionEndedError, useAuth } from '@/auth/AuthProvider';
import { createPatient, SubmitError } from '@/lib/api';
import { checkDraft, EMPTY_DRAFT, type DemographicsDraft, type DraftErrors } from '@/lib/demographicsDraft';
import { recordDemographics } from '@/lib/patientDemographics';

export interface AddPatientOutcome {
  patient: PatientDto;
  /** True when demographics were entered and saved; false when none were entered. */
  demographicsSaved: boolean;
  /** The list's `demographicsComplete` for the new patient: saved, with sex and ethnicity both recorded. */
  complete: boolean;
}

/**
 * Spec 025 T301: "Add patient" with demographics, shared by the panel and the Upload step. Two requests, in order: the patient (label), then its first
 * demographics version. Each retries with the request id it first used, so a lost response never makes a second patient or a second version. When the
 * second request fails, the patient already exists: `onCreated` has run, the draft is kept, and the next `submit` records only the demographics.
 * Nothing here ever puts a typed value in a message; the draft is cleared once it is saved.
 */
export function useAddPatient(onCreated: (patient: PatientDto) => void) {
  const { apiFetch } = useAuth();
  const [label, setLabel] = useState('');
  const [draft, setDraftState] = useState<DemographicsDraft>(EMPTY_DRAFT);
  const [labelError, setLabelError] = useState<string | null>(null);
  const [errors, setErrors] = useState<DraftErrors>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** The patient created by this form whose demographics are not saved yet. */
  const [pending, setPending] = useState<PatientDto | null>(null);
  const patientRequest = useRef<{ label: string; id: string } | null>(null);
  const demographicsRequest = useRef<{ key: string; id: string } | null>(null);

  function setDraft(next: DemographicsDraft) {
    setDraftState(next);
    setErrors({});
    setProblem(null);
  }

  function reset() {
    setLabel('');
    setDraftState(EMPTY_DRAFT);
    setLabelError(null);
    setErrors({});
    setProblem(null);
    setPending(null);
    patientRequest.current = null;
    demographicsRequest.current = null;
  }

  async function submit(): Promise<AddPatientOutcome | null> {
    const checked = checkDraft(draft, true);
    const parsedLabel = pending ? null : patientLabelSchema.safeParse(label);
    const badLabel = parsedLabel && !parsedLabel.success ? (parsedLabel.error.issues[0]?.message ?? 'Enter a synthetic patient label.') : null;
    setLabelError(badLabel);
    setErrors(checked.errors);
    if (badLabel || Object.keys(checked.errors).length) return null;
    setBusy(true);
    setProblem(null);
    let patient = pending;
    try {
      if (!patient) {
        const clean = parsedLabel!.success ? parsedLabel!.data : label;
        const attempt = patientRequest.current?.label === clean ? patientRequest.current : { label: clean, id: crypto.randomUUID() };
        patientRequest.current = attempt;
        patient = await createPatient(apiFetch, clean, attempt.id);
        patientRequest.current = null;
        onCreated(patient);
      }
      if (!checked.input) {
        reset();
        return { patient, demographicsSaved: false, complete: false };
      }
      const key = `${patient.id}:${JSON.stringify(checked.input)}`;
      const attempt = demographicsRequest.current?.key === key ? demographicsRequest.current : { key, id: crypto.randomUUID() };
      demographicsRequest.current = attempt;
      await recordDemographics(apiFetch, patient.id, checked.input, attempt.id);
      reset();
      return { patient, demographicsSaved: true, complete: checked.input.sex !== null && checked.input.ethnicity !== null };
    } catch (caught) {
      if (caught instanceof SessionEndedError) return null;
      const message = caught instanceof SubmitError ? caught.message : 'Please retry.';
      if (patient) {
        setPending(patient);
        setProblem(`${patient.label} was added, but its demographics were not saved. ${message}`);
      } else {
        setLabelError(caught instanceof SubmitError ? caught.message : 'The patient could not be added. Please retry.');
      }
      return null;
    } finally {
      setBusy(false);
    }
  }

  function changeLabel(next: string) {
    setLabel(next);
    setLabelError(null);
  }

  return { label, setLabel: changeLabel, draft, setDraft, labelError, errors, problem, busy, pending, submit, reset };
}
