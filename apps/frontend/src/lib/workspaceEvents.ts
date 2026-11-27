import type { PatientDto } from '@telesphoros/shared-types';

/**
 * The upload page, the patient forms, the sidebar's Recents and the patient lists show the same reports and patients from separate reads. Whichever
 * adds or removes one tells the others, in this tab only, so none keeps a stale list. Nothing leaves the page.
 */
const target = new EventTarget();
const REPORTS = 'telesphoros:reports-changed';
const PATIENT = 'telesphoros:patient-added';

export function announceReportsChanged(): void {
  target.dispatchEvent(new Event(REPORTS));
}
export function onReportsChanged(listener: () => void): () => void {
  target.addEventListener(REPORTS, listener);
  return () => target.removeEventListener(REPORTS, listener);
}
export function announcePatientAdded(patient: PatientDto): void {
  target.dispatchEvent(new CustomEvent<PatientDto>(PATIENT, { detail: patient }));
}
export function onPatientAdded(listener: (patient: PatientDto) => void): () => void {
  const handler = (event: Event) => listener((event as CustomEvent<PatientDto>).detail);
  target.addEventListener(PATIENT, handler);
  return () => target.removeEventListener(PATIENT, handler);
}
