import { randomUUID } from 'node:crypto';
import { organizationRunId } from '../../src/reports/intake/scope';
import type { ReportRecord } from '../../src/storage/records';
import type { ReportsRepository } from '../../src/storage/reports.repository';
import type { AttemptIdentity, UploadAttempt } from '../../src/storage/upload-attempt';

/**
 * Repository-level equivalents of what the validated intake does, for tests that need a report in a given upload state without sending bytes over HTTP.
 * These call the same repository methods the intake service calls, in the same order, so the rows they leave are the rows the intake leaves.
 */
export interface UploadHandle {
  attempt: UploadAttempt;
  identity: AttemptIdentity;
}

/** Declares an attempt: the report records the file (key, type, hash) and, once, its first requester. Returns undefined if the repository refuses. */
export async function declareUpload(
  reports: ReportsRepository,
  report: ReportRecord,
  input: { principal: string; sha256: string; contentType: string; key?: string; expectedRevision?: string },
): Promise<UploadHandle | undefined> {
  const current = (await reports.findById(report.tenantId, report.id))!;
  const revision = input.expectedRevision ?? current.uploadRevision!;
  const id = randomUUID();
  const attempt: UploadAttempt = {
    id, requestId: randomUUID(), runId: organizationRunId(report.tenantId), tenantId: report.tenantId, reportId: report.id, patientId: report.patientId,
    principal: input.principal, revision, declarationRevision: revision, type: report.type, sizeBytes: report.sizeBytes, contentType: input.contentType,
    sha256: input.sha256, key: input.key ?? `reports/test/${report.id}/intake/${id}`, cancelRequested: false, validated: false, state: 'declared', version: null,
    leaseUntil: new Date(Date.now() + 3_600_000).toISOString(), writer: null, createdAt: new Date().toISOString(),
  };
  const declared = await reports.declareAttempt(attempt, revision);
  if (!declared) return undefined;
  return { attempt: declared, identity: { tenantId: declared.tenantId, reportId: declared.reportId, id: declared.id, principal: declared.principal, revision: declared.revision } };
}

/** The rest of a successful intake: take the writer lease, validate, record the stored version, commit. Returns whether the commit pinned the report. */
export async function finishUpload(reports: ReportsRepository, handle: UploadHandle, version: string): Promise<boolean> {
  const writer = randomUUID();
  if (!(await reports.beginAttempt(handle.identity, writer))) return false;
  if (!(await reports.validateAttempt(handle.identity, writer))) return false;
  if (!(await reports.settleAttempt(handle.identity, writer, 'stored', version))) return false;
  return reports.commitAttempt(handle.identity);
}

/** Declare and finish in one step. Throws if either step is refused, so a fixture never silently stays half uploaded. */
export async function commitUpload(
  reports: ReportsRepository,
  report: ReportRecord,
  input: { principal: string; sha256: string; contentType: string; version: string; key?: string },
): Promise<UploadHandle> {
  const handle = await declareUpload(reports, report, input);
  if (!handle) throw new Error('The upload declaration was refused.');
  if (!(await finishUpload(reports, handle, input.version))) throw new Error('The upload could not be committed.');
  return handle;
}
