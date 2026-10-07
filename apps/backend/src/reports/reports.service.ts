import { createHash, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  REPORT_CONTENT_TYPES,
  type ReportCreate,
  type ReportListQuery,
  type ReportPatch,
  type ReportUploadUrlRequest,
  type ReportUploadUrlResponse,
} from '@telesphoros/shared-types';
import { AppException } from '../common/app-exception';
import type { Principal } from '../auth/principal';
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
  ) {}

  list(principal: Principal, { page, pageSize, patientId }: ReportListQuery) {
    return this.reports.list(principal.sub, { offset: (page - 1) * pageSize, limit: pageSize }, { patientId });
  }

  async get(principal: Principal, id: string): Promise<ReportRecord> {
    const record = await this.reports.findById(principal.sub, id);
    if (!record) throw AppException.notFound('Report not found.');
    return record;
  }

  /** Registers report metadata for one of the caller's own patients. The new status is always "received". */
  async create(principal: Principal, input: ReportCreate): Promise<ReportRecord> {
    // Same NOT_FOUND whether the patient is missing or belongs to someone else.
    if (!(await this.patients.findById(principal.sub, input.patientId))) {
      throw AppException.notFound('Patient not found.');
    }
    const now = new Date().toISOString();
    const record: ReportRecord = {
      id: randomUUID(),
      ownerId: principal.sub,
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
    await this.reports.delete(principal.sub, id);
  }

  /**
   * Upload step 1. Records what the client says it will send (type and SHA-256) and returns a
   * short-lived URL for ONE object. The object key is generated here, never taken from the client:
   * reports/<owner hash>/<report id>/<random>. Safe to call again before the upload completes.
   */
  async createUploadUrl(principal: Principal, id: string, input: ReportUploadUrlRequest): Promise<ReportUploadUrlResponse> {
    const report = await this.get(principal, id);
    if (report.uploadedAt) throw AppException.conflict('The file for this report was already uploaded.');
    if (!REPORT_CONTENT_TYPES[report.type].includes(input.contentType)) {
      throw AppException.validation([
        { field: 'contentType', message: `A ${report.type} report must be one of: ${REPORT_CONTENT_TYPES[report.type].join(', ')}.` },
      ]);
    }
    const storageKey = report.storageKey ?? objectKey(principal.sub, report.id);
    await this.reports.update({
      ...report,
      storageKey,
      contentType: input.contentType,
      sha256: input.sha256,
      updatedAt: new Date().toISOString(),
    });
    const target = await this.storage.createUploadTarget({ key: storageKey, contentType: input.contentType, sizeBytes: report.sizeBytes });
    return { uploadUrl: target.url, method: target.method, headers: target.headers, expiresAt: target.expiresAt };
  }

  /**
   * Upload step 2. The server reads the stored object back and checks size, content type and
   * SHA-256 against what was declared. Only then is the report marked uploaded. Idempotent.
   */
  async completeUpload(principal: Principal, id: string): Promise<ReportRecord> {
    const report = await this.get(principal, id);
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
    const completed = { ...report, uploadedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await this.reports.update(completed);
    return completed;
  }
}

/** The owner appears only as a hash: a stable per-owner prefix (for storage policies) with no raw identifier or unsafe characters. */
function objectKey(ownerId: string, reportId: string): string {
  const ownerPrefix = createHash('sha256').update(ownerId).digest('hex').slice(0, 32);
  return `reports/${ownerPrefix}/${reportId}/${randomUUID()}`;
}
