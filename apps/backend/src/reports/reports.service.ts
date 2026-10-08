import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  filenameMatchesType,
  REPORT_CONTENT_TYPES,
  type ReportCreate,
  type ReportListQuery,
  type ReportPatch,
  type ReportType,
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

  /** A `lab-pdf` report belongs to the pipeline: while it is switched off, creating, changing or uploading one answers 503 and does nothing. */
  private gate(...types: ReportType[]): void {
    if (types.includes('lab-pdf')) this.pipeline.assertEnabled();
  }

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
    this.gate(input.type);
    // Same NOT_FOUND whether the patient is missing or belongs to someone else.
    if (!(await this.patients.findById(principal.tenantId, input.patientId))) {
      throw AppException.notFound('Patient not found.');
    }
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
      createdAt: now,
      updatedAt: now,
    };
    await this.reports.insert(record);
    return record;
  }

  async patch(principal: Principal, id: string, patch: ReportPatch): Promise<ReportRecord> {
    const existing = await this.get(principal, id);
    this.gate(existing.type, patch.type ?? existing.type);
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
    return updated;
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
    this.gate(report.type);
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
    this.gate(report.type);
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
    if (report.type === 'lab-pdf' && !stored.version) {
      throw AppException.conflictBecause('source-unpinned', 'The stored file has no version, so it cannot be used as evidence. Enable versioning on the reports bucket.');
    }
    const now = new Date().toISOString();
    const completed: ReportRecord = { ...report, uploadedAt: now, objectVersion: stored.version ?? null, uploadedBy: principal.sub, updatedAt: now };
    // If someone completed it first, keep THEIR record: a repeated complete changes nobody's identity.
    if (!(await this.reports.markUploaded(completed))) return this.get(principal, id);
    return completed;
  }
}
