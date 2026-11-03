import { Injectable } from '@nestjs/common';
import {
  findSyntheticPgxRevisionConflicts,
  inspectSyntheticPgxLineage,
  type ReviewedFinding,
  type StructuredConflict,
  type StructuredFindingReviewCreate,
  type StructuredPreview,
  type StructuredRecordCreate,
  type StructuredRecordState,
  type StructuredReviewState,
  type StructuredSourceResolutionCreate,
} from '@telesphoros/shared-types';
import type { Principal } from '../auth/principal';
import { AppException } from '../common/app-exception';
import { StructuredRevisionsRepository, type StoredSourceResolution, type StoredStructuredRevision, type StructuredSnapshot } from '../storage/structured-revisions.repository';
import { StructuredPreviewService } from './structured-preview.service';

const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();
const REOPEN = 'The stored evidence changed. Reopen the report.';
type Evaluation = ReturnType<StructuredRecordsService['evaluate']>;

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
  /**
   * Record an independent decision about one stored finding. It says the stored finding does or does not match its source; it never changes
   * the finding's own uncertainty and never makes it actionable. Patient matching is a separate, earlier record that this never writes.
   */
  async review(principal: Principal, id: string, body: StructuredFindingReviewCreate) {
    const p = await this.preview.get(principal, id);
    if (
      body.patientId !== p.patientId ||
      body.sha256 !== p.source.sha256 ||
      body.objectVersion !== p.source.objectVersion ||
      p.patientLink.state !== 'verified' ||
      body.patientLinkDecisionId !== p.patientLink.decision?.id
    )
      throw AppException.conflict('A current independent patient-link review and unchanged source are required.');
    const created = await this.records.recordReview(principal.tenantId, principal.sub, p, body, (snapshot) => {
      const revision = snapshot.revisions.find((r) => r.id === body.revisionId && r.reportId === p.reportId);
      if (!revision || snapshot.revisions.some((r) => !r.currentBinding)) throw AppException.conflict(REOPEN);
      if (this.evaluate(principal.tenantId, p.patientId, snapshot).disposition(revision).state !== 'candidate-for-review')
        throw AppException.conflict('This revision is not open for findings review.');
      if (!revision.laboratoryReport.findings.some((f) => f.id === body.findingId)) throw AppException.conflict('That finding is not part of the stored revision.');
    });
    return { created, state: await this.state(principal, p) };
  }
  /**
   * Record an explicit choice between conflicting stored sources of one laboratory revision. Nothing is deleted or merged: a source that is
   * not chosen stays in history, marked not selected, and its findings are never read again.
   */
  async resolve(principal: Principal, id: string, body: StructuredSourceResolutionCreate) {
    const p = await this.preview.get(principal, id);
    if (body.patientId !== p.patientId) throw AppException.conflict(REOPEN);
    const created = await this.records.recordResolution(principal.tenantId, principal.sub, p, body, (snapshot) => {
      if (snapshot.revisions.some((r) => !r.currentBinding)) throw AppException.conflict(REOPEN);
      const conflict = this.evaluate(principal.tenantId, p.patientId, snapshot).conflicts.find(
        (c) => c.laboratoryId === body.laboratoryId && c.seriesId === body.seriesId && c.revision === body.revision,
      );
      if (!conflict || !sameSet(conflict.revisionIds, body.revisionIds)) throw AppException.conflict('The set of conflicting sources changed. Reopen the report.');
      if (!conflict.revisionIds.some((rid) => snapshot.revisions.find((r) => r.id === rid)?.reportId === p.reportId))
        throw AppException.conflict('Open the report of one of the conflicting sources to resolve it.');
    });
    return { created, state: await this.state(principal, p) };
  }

  /** Pure reconciliation of one patient's complete stored set: conflicts, the resolutions still current, and each source's disposition. */
  private evaluate(tenantId: string, patientId: string, snapshot: StructuredSnapshot) {
    const { revisions, resolutions } = snapshot;
    const sources = (list: StoredStructuredRevision[]) =>
      list.map((r) => ({ sourceId: r.id, tenantId, patientId: r.patientId, sha256: r.sha256, objectVersion: r.objectVersion, report: r.laboratoryReport }));
    const conflicts = findSyntheticPgxRevisionConflicts({ tenantId, patientId, sources: sources(revisions) }).map((c) => {
      // Only the newest resolution made about exactly this set counts. A later source for the series makes an earlier one stale.
      const current = resolutions
        .filter((x) => x.laboratoryId === c.laboratoryId && x.seriesId === c.seriesId && x.revision === c.revision && sameSet(x.revisionIds, c.sourceIds))
        .at(-1);
      return { laboratoryId: c.laboratoryId, seriesId: c.seriesId, revision: c.revision, revisionIds: c.sourceIds, resolution: current ?? null };
    });
    const selected = new Set<string>();
    const notSelected = new Set<string>();
    for (const c of conflicts)
      if (c.resolution?.outcome === 'use-revision') {
        selected.add(c.resolution.chosenRevisionId!);
        for (const rid of c.revisionIds) if (rid !== c.resolution.chosenRevisionId) notSelected.add(rid);
      }
    // A source the reviewer did not select stays stored and visible, but takes no part in lineage again.
    const inspection = inspectSyntheticPgxLineage({ tenantId, patientId, sources: sources(revisions.filter((r) => !notSelected.has(r.id))) });
    const disposition = (r: StoredStructuredRevision): { state: StructuredRecordState['state']; reasons: string[] } => {
      if (revisions.some((x) => !x.currentBinding)) return { state: 'held', reasons: ['source-or-review-changed'] };
      if (notSelected.has(r.id)) return { state: 'superseded', reasons: ['not-selected-by-source-resolution'] };
      const series = inspection.series.find((s) => s.laboratoryId === r.laboratoryReport.laboratoryId && s.seriesId === r.laboratoryReport.seriesId)!;
      if (series.state === 'held') return { state: 'held', reasons: series.reasons };
      return { state: series.candidate?.sourceIds.includes(r.id) ? 'candidate-for-review' : 'superseded', reasons: [] };
    };
    return { conflicts, selected, notSelected, disposition };
  }

  private async state(principal: Principal, p: StructuredPreview): Promise<StructuredRecordState> {
    const snapshot = await this.records.read(principal.tenantId, p);
    const evaluation = this.evaluate(principal.tenantId, p.patientId, snapshot);
    const history = snapshot.revisions.map((r) => ({
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
      selection: evaluation.selected.has(r.id) ? ('selected' as const) : evaluation.notSelected.has(r.id) ? ('not-selected' as const) : null,
    }));
    const stored = snapshot.revisions.find((r) => r.reportId === p.reportId);
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
    if (!stored || !record)
      return { ...base, state: 'not-recorded', reasons: [], review: { status: 'not-reviewable', findings: [], outstanding: [], evidenceOnly: true }, conflict: null };
    const { state, reasons } = evaluation.disposition(stored);
    const conflict = this.conflictFor(stored, evaluation);
    return { ...base, state, reasons, review: this.reviewState(stored, state, reasons, conflict, snapshot), conflict };
  }

  private conflictFor(r: StoredStructuredRevision, { conflicts }: Evaluation): StructuredConflict | null {
    const mine = conflicts.filter((c) => c.laboratoryId === r.laboratoryReport.laboratoryId && c.seriesId === r.laboratoryReport.seriesId);
    const c = mine.find((x) => x.revisionIds.includes(r.id)) ?? mine[0];
    if (!c) return null;
    const x: StoredSourceResolution | null = c.resolution;
    return {
      laboratoryId: c.laboratoryId,
      seriesId: c.seriesId,
      revision: c.revision,
      revisionIds: c.revisionIds,
      resolution: x ? { id: x.id, outcome: x.outcome, chosenRevisionId: x.chosenRevisionId, reasonCode: x.reasonCode, createdAt: x.createdAt } : null,
    };
  }

  private reviewState(
    r: StoredStructuredRevision,
    state: StructuredRecordState['state'],
    reasons: string[],
    conflict: StructuredConflict | null,
    snapshot: StructuredSnapshot,
  ): StructuredReviewState {
    const findings: ReviewedFinding[] = r.laboratoryReport.findings.map((f) => {
      const decided = snapshot.reviews.find((x) => x.revisionId === r.id && x.findingId === f.id);
      return {
        findingId: f.id,
        targetId: f.targetId ?? null,
        gene: f.gene ?? null,
        coverage: f.coverage ?? null,
        analyticalState: f.analyticalState ?? null,
        interpretationState: f.interpretationState ?? null,
        decision: decided?.decision ?? 'unreviewed',
        reasonCode: decided?.reasonCode ?? null,
        decidedAt: decided?.createdAt ?? null,
        actionable: false as const,
      };
    });
    const outstanding: StructuredReviewState['outstanding'] = [];
    if (state === 'held') {
      if (reasons.includes('source-or-review-changed')) outstanding.push('recheck-changed-binding');
      else {
        if (conflict && !conflict.resolution) outstanding.push('resolve-source-conflict');
        if (reasons.some((x) => x !== 'duplicate-revision-content') || conflict?.resolution) outstanding.push('await-new-source');
      }
    }
    if (state !== 'candidate-for-review') return { status: 'not-reviewable', findings, outstanding, evidenceOnly: true };
    const unreviewed = findings.filter((f) => f.decision === 'unreviewed').length;
    const held = findings.filter((f) => f.decision === 'held').length;
    if (unreviewed) outstanding.push('review-findings');
    if (held) outstanding.push('reopen-held-findings');
    const status = findings.length > 0 && unreviewed === findings.length ? 'awaiting-review' : unreviewed ? 'in-progress' : held ? 'attention' : 'complete';
    return { status, findings, outstanding, evidenceOnly: true };
  }
}
