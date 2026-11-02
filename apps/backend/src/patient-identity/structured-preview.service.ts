import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { Inject, Injectable } from '@nestjs/common';
import { parseSyntheticPgxPackage, SYNTHETIC_PGX_MAX_BYTES, type StructuredPatientLink, type StructuredPreview } from '@telesphoros/shared-types';
import type { Principal } from '../auth/principal';
import { AppException } from '../common/app-exception';
import { ENV, type Env } from '../config/env';
import { ObjectStorage, ObjectTooLargeError } from '../object-storage/object-storage';
import { assertLocalStorage } from '../reports/intake/local-policy';
import { PatientsRepository } from '../storage/patients.repository';
import { ReportsRepository } from '../storage/reports.repository';
import { PatientLinkService } from './patient-link.service';

@Injectable()
export class StructuredPreviewService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly reports: ReportsRepository,
    private readonly patients: PatientsRepository,
    private readonly objects: ObjectStorage,
    private readonly links: PatientLinkService,
  ) {}

  assertEnabled() {
    assertLocalStorage(this.env);
    if (this.env.STORAGE_DRIVER !== 'postgres' || this.env.OBJECT_STORAGE_DRIVER !== 's3')
      throw AppException.unavailable('Structured inspection requires owned local PostgreSQL and versioned object storage.');
  }

  async get(principal: Principal, id: string): Promise<StructuredPreview> {
    this.assertEnabled();
    const report = await this.reports.findById(principal.tenantId, id);
    if (!report) throw AppException.notFound();
    if (!report.uploadedAt || !report.storageKey || !report.sha256 || !report.objectVersion) throw AppException.conflict('Upload the file before inspecting its findings.');
    if (report.type !== 'structured' || report.contentType !== 'application/json' || report.sizeBytes > SYNTHETIC_PGX_MAX_BYTES) throw AppException.unsupportedSource();
    let object;
    try {
      object = await this.objects.getObject(report.storageKey, { version: report.objectVersion, maxBytes: SYNTHETIC_PGX_MAX_BYTES });
    } catch (error) {
      if (error instanceof ObjectTooLargeError) throw AppException.unsupportedSource();
      throw AppException.unavailable('The stored file could not be read. Try again.');
    }
    if (
      !object ||
      object.version !== report.objectVersion ||
      object.sizeBytes !== report.sizeBytes ||
      object.bytes.length !== report.sizeBytes ||
      object.contentType !== report.contentType ||
      createHash('sha256').update(object.bytes).digest('hex') !== report.sha256
    )
      throw AppException.conflict('The pinned file could not be verified. No findings or decision are available.');
    let laboratoryReport;
    try {
      laboratoryReport = parseSyntheticPgxPackage(new TextDecoder('utf-8', { fatal: true }).decode(object.bytes)).report;
    } catch {
      throw AppException.unsupportedSource();
    }
    const patientLink = await this.links.get(principal, id);
    // Re-read after storage and ledger access; never display evidence for a changed or removed binding.
    const current = await this.reports.findById(principal.tenantId, id);
    const patient = await this.patients.findById(principal.tenantId, report.patientId);
    if (!current || !patient) throw AppException.notFound();
    if (
      current.updatedAt !== report.updatedAt ||
      current.patientId !== report.patientId ||
      current.sha256 !== report.sha256 ||
      current.objectVersion !== report.objectVersion ||
      patient.mergedInto
    )
      throw AppException.conflict('The report or patient changed. Open the report again.');
    return {
      reportId: id,
      patientId: patient.id,
      patientLabel: patient.label,
      source: { sha256: report.sha256, objectVersion: report.objectVersion },
      laboratoryReport,
      patientLink,
      canReview: principal.roles.includes('reviewer') && ![report.createdBy, report.uploadRequestedBy, report.uploadedBy].includes(principal.sub),
      lineage: 'not-reconciled',
      synthetic: true,
      clinicalUse: 'not-approved',
      actionable: false,
    };
  }

  async decide(principal: Principal, id: string, body: StructuredPatientLink) {
    const preview = await this.get(principal, id);
    if (
      body.patientId !== preview.patientId ||
      body.sha256 !== preview.source.sha256 ||
      body.objectVersion !== preview.source.objectVersion ||
      body.sourcePatientReference !== preview.laboratoryReport.patientId
    )
      throw AppException.conflict('The source or patient differs from the preview. Open the report again before deciding.');
    return this.links.decide(
      principal,
      id,
      { method: 'person-confirmed', decision: body.decision, basisCode: body.basisCode },
      { patientId: preview.patientId, ...preview.source },
    );
  }
}
