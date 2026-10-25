import type { ReportType } from '@telesphoros/shared-types';
export type UploadState = 'declared' | 'intaking' | 'stored' | 'unresolved' | 'cancelling' | 'cancelled' | 'committed' | 'cleanup' | 'cleaned';
export interface UploadAttempt {
  id: string;
  requestId: string;
  runId: string;
  tenantId: string;
  reportId: string;
  patientId: string;
  principal: string;
  revision: string;
  /** Original request token, before declaration rotates the report revision. */
  declarationRevision: string;
  type: ReportType;
  sizeBytes: number;
  contentType: string;
  sha256: string;
  key: string;
  cancelRequested: boolean;
  validated: boolean;
  state: UploadState;
  version: string | null;
  leaseUntil: string;
  writer: string | null;
  createdAt: string;
}
export interface AttemptIdentity {
  tenantId: string;
  reportId: string;
  id: string;
  principal: string;
  revision: string;
}
export const sameAttempt = (a: UploadAttempt, b: UploadAttempt) =>
  ['requestId', 'runId', 'tenantId', 'reportId', 'patientId', 'principal', 'declarationRevision', 'type', 'sizeBytes', 'contentType', 'sha256'].every(
    (k) => a[k as keyof UploadAttempt] === b[k as keyof UploadAttempt],
  );
