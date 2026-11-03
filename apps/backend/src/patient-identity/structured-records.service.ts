import { Injectable } from '@nestjs/common';
import { inspectSyntheticPgxLineage, type StructuredPreview, type StructuredRecordCreate, type StructuredRecordState } from '@telesphoros/shared-types';
import type { Principal } from '../auth/principal';
import { AppException } from '../common/app-exception';
import { StructuredRevisionsRepository } from '../storage/structured-revisions.repository';
import { StructuredPreviewService } from './structured-preview.service';

@Injectable()
export class StructuredRecordsService {
  constructor(
    private readonly preview: StructuredPreviewService,
    private readonly records: StructuredRevisionsRepository,
  ) {}
  async get(principal: Principal, id: string) {
    return this.state(principal, await this.preview.get(principal, id));
  }
  async save(principal: Principal, id: string, body: StructuredRecordCreate) {
    const p = await this.preview.get(principal, id);
    if (
      body.patientId !== p.patientId ||
      body.sha256 !== p.source.sha256 ||
      body.objectVersion !== p.source.objectVersion ||
      body.sourcePatientReference !== p.laboratoryReport.patientId ||
      p.patientLink.state !== 'verified' ||
      body.patientLinkDecisionId !== p.patientLink.decision?.id
    )
      throw AppException.conflict('A current independent patient-link review and unchanged source are required.');
    const created = await this.records.save(principal.tenantId, principal.sub, p);
    return { created, state: await this.state(principal, p) };
  }
  private async state(principal: Principal, p: StructuredPreview): Promise<StructuredRecordState> {
    const records = await this.records.read(principal.tenantId, p);
    const history = records.map((r) => ({
      id: r.id,
      reportId: r.reportId,
      laboratoryId: r.laboratoryReport.laboratoryId,
      seriesId: r.laboratoryReport.seriesId,
      laboratoryReportId: r.laboratoryReport.id,
      revision: r.laboratoryReport.revision,
      status: r.laboratoryReport.status,
      createdAt: r.createdAt,
      findingIds: r.laboratoryReport.findings.map((f) => f.id),
      currentBinding: r.currentBinding,
    }));
    const record = history.find((r) => r.reportId === p.reportId) ?? null;
    const base = {
      reportId: p.reportId,
      patientId: p.patientId,
      record,
      history,
      synthetic: true as const,
      clinicalUse: 'not-approved' as const,
      actionable: false as const,
      independentReviewRequired: true as const,
    };
    if (!record) return { ...base, state: 'not-recorded', reasons: [] };
    if (records.some((r) => !r.currentBinding)) return { ...base, state: 'held', reasons: ['source-or-review-changed'] };
    const inspection = inspectSyntheticPgxLineage({
      tenantId: principal.tenantId,
      patientId: p.patientId,
      sources: records.map((r) => ({
        sourceId: r.reportId,
        tenantId: principal.tenantId,
        patientId: r.patientId,
        sha256: r.sha256,
        objectVersion: r.objectVersion,
        report: r.laboratoryReport,
      })),
    });
    const series = inspection.series.find((s) => s.laboratoryId === record.laboratoryId && s.seriesId === record.seriesId)!;
    if (series.state === 'held') return { ...base, state: 'held', reasons: series.reasons };
    return { ...base, state: series.candidate?.sourceIds.includes(p.reportId) ? 'candidate-for-review' : 'superseded', reasons: [] };
  }
}
