import { createHash, randomUUID } from 'node:crypto';
import { FILE_LINK_ROLES } from '../auth/file-access';
import { Injectable } from '@nestjs/common';
import {
  filenameMatchesType,
  REPORT_CONTENT_TYPES,
  type ReportCreate,
  type ReportListQuery,
  type ReportPatch,
  type ReportUploadUrlRequest,
  type ReportUploadUrlResponse,
} from '@telesphoros/shared-types';
import { AppException } from '../common/app-exception';
import type { Principal } from '../auth/principal';
import { reportObjectKey } from '../lab-reports/object-keys';
import { PipelineSwitch } from '../lab-reports/pipeline-switch';
import { ObjectStorage } from '../object-storage/object-storage';
import { PatientsRepository } from '../storage/patients.repository';
import type { ReportRecord } from '../storage/records';
import { ReportsRepository } from '../storage/reports.repository';

@Injectable()
export class ReportsService {
  constructor(
    private readonly reports: ReportsRepository,
    private readonly patients: PatientsRepository,
    private readonly storage: ObjectStorage,
    private readonly pipeline: PipelineSwitch,
  ) {}

  list(principal: Principal, { page, pageSize, patientId }: ReportListQuery) {
    return this.reports.list(principal.tenantId, { offset: (page - 1) * pageSize, limit: pageSize }, { patientId });
  }

  async get(principal: Principal, id: string): Promise<ReportRecord> {
    const record = await this.reports.findById(principal.tenantId, id);
    if (!record) throw AppException.notFound('Report not found.');
    return record;
  }

  /** Registers report metadata for one of the caller's own patients. The new status is always "received". */
  async create(principal: Principal, input: ReportCreate): Promise<ReportRecord> {
    // Same NOT_FOUND whether the patient is missing or belongs to someone else.
    const patient = await this.patients.findById(principal.tenantId, input.patientId);
    if (!patient) {
      throw AppException.notFound('Patient not found.');
    }
    // A merged-away patient keeps what it has but takes nothing new: the report belongs on the patient it was merged into.
    if (patient.mergedInto) throw AppException.conflictBecause('patient-merged', `That patient was merged into patient ${patient.mergedInto}. Register the report there.`);
    const now = new Date().toISOString();
    const record: ReportRecord = {
      id: randomUUID(),
      tenantId: principal.tenantId,
      createdBy: principal.sub,
      patientId: input.patientId,
      type: input.type,
      filename: input.filename,
      sizeBytes: input.sizeBytes,
      status: 'received',
      ...(input.requestId ? {
        creationRequestId: input.requestId,
        // Fixed tuple: request property order and later metadata corrections cannot change the original identity.
        creationRequestHash: createHash('sha256').update(JSON.stringify([
          input.patientId.toLowerCase(), input.type, input.filename, input.sizeBytes,
        ])).digest('hex'),
      } : {}),
      createdAt: now,
      updatedAt: now,
    };
    if (input.requestId) return this.reports.insertOrReplay(record);
    await this.reports.insert(record);
    return this.get(principal,record.id);
  }

  async patch(principal: Principal, id: string, patch: ReportPatch): Promise<ReportRecord> {
    const existing = await this.get(principal, id);
    if (existing.uploadedAt && patch.type !== undefined && patch.type !== existing.type) throw AppException.conflict('An uploaded report cannot change its type.');
    // Create checks that name and type agree; a patch may change only one of them, so check the result.
    const type = patch.type ?? existing.type;
    const filename = patch.filename ?? existing.filename;
    if (!filenameMatchesType(type, filename)) {
      throw AppException.validation([{ field: 'filename', message: 'The file name must end in the extension of the report type.' }]);
    }
    const updated: ReportRecord = {
      ...existing,
      ...(patch.type !== undefined ? { type: patch.type } : {}),
      ...(patch.filename !== undefined ? { filename: patch.filename } : {}),
      updatedAt: new Date().toISOString(),
    };
    await this.reports.update(updated);
    return this.get(principal, id);
  }

  async downloadUrl(principal: Principal,id: string) {
    if(!principal.roles.some(r=>FILE_LINK_ROLES.includes(r as typeof FILE_LINK_ROLES[number])))throw AppException.forbidden();
    const report=await this.get(principal,id);
    if(!await this.patients.findById(principal.tenantId,report.patientId))throw AppException.notFound();
    if(!report.uploadedAt||!report.storageKey||!report.objectVersion||report.objectVersion==='null'||!report.sha256||!report.contentType)throw AppException.conflictBecause('source-unpinned','A verified pinned upload is required.');
    const stored=await this.storage.inspect(report.storageKey,{version:report.objectVersion});
    if(!stored||stored.version!==report.objectVersion||stored.sha256!==report.sha256||stored.sizeBytes!==report.sizeBytes||stored.contentType!==report.contentType)throw AppException.conflictBecause('source-changed','The stored version is missing or does not match the verified file.');
    const current=await this.get(principal,id);if(current.objectVersion!==report.objectVersion||current.storageKey!==report.storageKey)throw AppException.conflict('The report changed during verification.');
    const ttl=this.pipeline.downloadUrlTtlSeconds;
    return {url:await this.storage.createDownloadUrl(report.storageKey,report.objectVersion,ttl,{filename:current.filename}),expiresAt:new Date(Date.now()+ttl*1000).toISOString()};
  }

  async remove(principal: Principal, id: string): Promise<void> {
    await this.get(principal, id);
    await this.reports.delete(principal.tenantId, id);
  }

  /**
   * Upload step 1. Records what the client says it will send (type and SHA-256) and returns a
   * short-lived URL for ONE object. The object key is generated here, never taken from the client:
   * reports/<tenant hash>/<report id>/<random>. Safe to call again before the upload completes.
   */
  async createUploadUrl(principal: Principal, id: string, input: ReportUploadUrlRequest): Promise<ReportUploadUrlResponse> {
    const report = await this.get(principal, id);
    if (this.pipeline.localStorageOnly) throw AppException.conflictBecause('validated-intake-required', 'Use validated server intake before storage.');
    if(report.type==='lab-pdf')this.pipeline.assertEnabled();
    if (report.uploadedAt) throw AppException.conflict('The file for this report was already uploaded.');
    if (!REPORT_CONTENT_TYPES[report.type].includes(input.contentType)) {
      throw AppException.validation([
        { field: 'contentType', message: `A ${report.type} report must be one of: ${REPORT_CONTENT_TYPES[report.type].join(', ')}.` },
      ]);
    }
    const storageKey = report.storageKey ?? reportObjectKey(principal.tenantId, report.id);
    const recorded = await this.reports.recordUploadRequest({
      ...report,
      storageKey,
      contentType: input.contentType,
      sha256: input.sha256,
      // Only the FIRST requester is kept (the repository never replaces it); later requests change nobody's identity.
      uploadRequestedBy: principal.sub,
      updatedAt: new Date().toISOString(),
    });
    if (!recorded) throw AppException.conflict('The file for this report was already uploaded.');
    const target = await this.storage.createUploadTarget({ key: storageKey, contentType: input.contentType, sizeBytes: report.sizeBytes });
    return { uploadUrl: target.url, method: target.method, headers: target.headers, expiresAt: target.expiresAt };
  }

  /**
   * Upload step 2. The server reads the stored object back and checks size, content type and
   * SHA-256 against what was declared. Only then is the report marked uploaded. Idempotent.
   */
  async completeUpload(principal: Principal, id: string): Promise<ReportRecord> {
    const report = await this.get(principal, id);
    if (this.pipeline.localStorageOnly) throw AppException.conflictBecause('validated-intake-required', 'Use validated server intake before storage.');
    if(report.type==='lab-pdf')this.pipeline.assertEnabled();
    if (report.uploadedAt) return report;
    if (!report.storageKey || !report.sha256 || !report.contentType) {
      throw AppException.conflict('Request an upload URL for this report first.');
    }
    const stored = await this.storage.inspect(report.storageKey);
    if (!stored) throw AppException.conflict('The file has not been uploaded yet.');
    if (stored.sizeBytes !== report.sizeBytes) {
      throw AppException.conflict('The uploaded file size does not match the declared size.');
    }
    if (stored.contentType && stored.contentType !== report.contentType) {
      throw AppException.conflict('The uploaded file content type does not match the declared type.');
    }
    if (stored.sha256 !== report.sha256) {
      throw AppException.conflict('The uploaded file does not match its checksum.');
    }
    // The version came back in the SAME response as the bytes that were just hashed, so it names exactly the verified object.
    // A lab PDF is evidence and must be pinned to a real version; without versioning there is nothing to pin.
    if (!stored.version || stored.version === 'null') {
      throw AppException.conflictBecause('source-unpinned', 'The stored file has no version, so it cannot be used as evidence. Enable versioning on the reports bucket.');
    }
    const now = new Date().toISOString();
    const completed: ReportRecord = { ...report, uploadedAt: now, objectVersion: stored.version ?? null, uploadedBy: principal.sub, updatedAt: now };
    // If someone completed it first, keep THEIR record: a repeated complete changes nobody's identity.
    if (!(await this.reports.markUploaded(completed))) {
      const winner=await this.get(principal,id);
      if(winner.storageKey!==completed.storageKey || winner.objectVersion!==completed.objectVersion || winner.sha256!==completed.sha256) throw AppException.conflict('The upload declaration changed during verification.');
      return winner;
    }
    return completed;
  }
}
