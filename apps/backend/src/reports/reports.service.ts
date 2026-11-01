import { createHash, randomUUID } from 'node:crypto';
import { FILE_LINK_ROLES } from '../auth/file-access';
import { Injectable } from '@nestjs/common';
import { filenameMatchesType, type ReportCreate, type ReportListQuery, type ReportPatch } from '@telesphoros/shared-types';
import { AppException } from '../common/app-exception';
import type { Principal } from '../auth/principal';
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

  list(principal: Principal, { page, pageSize, patientId, order }: Omit<ReportListQuery, 'order'> & { order?: ReportListQuery['order'] }) {
    return this.reports.list(principal.tenantId, { offset: (page - 1) * pageSize, limit: pageSize, order }, { patientId });
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
      ...(input.requestId
        ? {
            creationRequestId: input.requestId,
            // Fixed tuple: request property order and later metadata corrections cannot change the original identity.
            creationRequestHash: createHash('sha256')
              .update(JSON.stringify([input.patientId.toLowerCase(), input.type, input.filename, input.sizeBytes]))
              .digest('hex'),
          }
        : {}),
      createdAt: now,
      updatedAt: now,
    };
    if (input.requestId) return this.reports.insertOrReplay(record);
    await this.reports.insert(record);
    return this.get(principal, record.id);
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

  async downloadUrl(principal: Principal, id: string) {
    if (!principal.roles.some((r) => FILE_LINK_ROLES.includes(r as (typeof FILE_LINK_ROLES)[number]))) throw AppException.forbidden();
    const report = await this.get(principal, id);
    if (!(await this.patients.findById(principal.tenantId, report.patientId))) throw AppException.notFound();
    if (!report.uploadedAt || !report.storageKey || !report.objectVersion || report.objectVersion === 'null' || !report.sha256 || !report.contentType)
      throw AppException.conflictBecause('source-unpinned', 'A verified pinned upload is required.');
    const stored = await this.storage.inspect(report.storageKey, { version: report.objectVersion });
    if (!stored || stored.version !== report.objectVersion || stored.sha256 !== report.sha256 || stored.sizeBytes !== report.sizeBytes || stored.contentType !== report.contentType)
      throw AppException.conflictBecause('source-changed', 'The stored version is missing or does not match the verified file.');
    const current = await this.get(principal, id);
    if (current.objectVersion !== report.objectVersion || current.storageKey !== report.storageKey) throw AppException.conflict('The report changed during verification.');
    const ttl = this.pipeline.downloadUrlTtlSeconds;
    return {
      url: await this.storage.createDownloadUrl(report.storageKey, report.objectVersion, ttl, { filename: current.filename }),
      expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
    };
  }

  async remove(principal: Principal, id: string): Promise<void> {
    await this.get(principal, id);
    await this.reports.delete(principal.tenantId, id);
  }
}
