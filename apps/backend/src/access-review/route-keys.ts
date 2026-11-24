/**
 * Spec 046 D4: what the subject of an access-audit row is, by the row's static route key (`Controller.handler`, never a URL). The audit stores the
 * path's id, so a patient route's subject is the patient, an evaluation's or a report's is that record, and the evaluations list's is the patient
 * it names (AR-2). Anything unlisted is `other`: a read the review shows but cannot tie to a patient. route-keys.spec.ts derives the patient-scoped
 * reads from the controllers' own routing metadata and fails when one is missing here.
 */
export type SubjectKind = 'patient' | 'evaluation' | 'report' | 'other';

export const SUBJECT_KIND_BY_ROUTE: Readonly<Record<string, Exclude<SubjectKind, 'other'>>> = {
  'PatientsController.get': 'patient',
  'PatientDemographicsController.get': 'patient',
  'PatientIdentifiersController.list': 'patient',
  'PatientMedicationsController.get': 'patient',
  'PatientFollowupsController.read': 'patient',
  'EvaluationsController.list': 'patient',
  'EvaluationsController.get': 'evaluation',
  'ReportsController.get': 'report',
  'ReportsController.downloadUrl': 'report',
  'ReportsController.uploadState': 'report',
  'ReportPatientLinkController.get': 'report',
};

export function subjectKindOf(routeKey: string): SubjectKind {
  return SUBJECT_KIND_BY_ROUTE[routeKey] ?? 'other';
}
