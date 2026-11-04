import type { GeneInput } from '@telesphoros/cpic-schema';
import { reconcileStructured } from '../patient-identity/structured-reconciliation';
import type { StoredStructuredRevision, StructuredSnapshot } from '../storage/structured-revisions.repository';
import type { StructuredHoldCode } from './structured-hold-codes';

export type StructuredAssessmentPlan =
  /** Nothing is stored: the evidence is not what the reviewer saw, or this revision is not the one under review. */
  | { kind: 'refused'; reason: 'not-recorded' | 'source-changed' | 'superseded' }
  /** Stored as a held evaluation with no result. `detail` names codes only, never a value from the report. */
  | { kind: 'held'; revision: StoredStructuredRevision; holdCode: StructuredHoldCode; detail: string[] }
  | { kind: 'ready'; revision: StoredStructuredRevision; geneInputs: GeneInput[]; reviewIds: string[] };

const ELIGIBLE_STATUS = new Set(['final', 'amended', 'corrected']);

/**
 * Decides what a stored structured revision may be assessed on. Pure: the same snapshot gives the same plan. It never infers: a finding that is
 * unreviewed, rejected, uncertain, not tested, or not a resolved diplotype stops the whole revision, and the laboratory's own phenotype is never
 * used in place of the knowledge set's mapping from the diplotype. Holds are ranked: a conflict first (nothing about the sources is settled),
 * then findings no second person has accepted, then an unsupported kind of source, then findings that are uncertain.
 */
export function planStructuredAssessment(tenantId: string, report: { id: string; patientId: string }, snapshot: StructuredSnapshot): StructuredAssessmentPlan {
  const revision = snapshot.revisions.find((r) => r.reportId === report.id);
  if (!revision || revision.patientId !== report.patientId) return { kind: 'refused', reason: 'not-recorded' };

  const { state, reasons } = reconcileStructured(tenantId, report.patientId, snapshot).disposition(revision);
  if (state === 'superseded') return { kind: 'refused', reason: 'superseded' };
  if (state === 'held') {
    if (reasons.includes('source-or-review-changed')) return { kind: 'refused', reason: 'source-changed' };
    const onlyStatus = reasons.length > 0 && reasons.every((r) => r === 'latest-status-ineligible');
    return { kind: 'held', revision, holdCode: onlyStatus ? 'unsupported-source' : 'source-conflict', detail: reasons };
  }

  const { laboratoryReport: lab } = revision;
  const decisions = lab.findings.map((f) => ({ finding: f, review: snapshot.reviews.find((x) => x.revisionId === revision.id && x.findingId === f.id) }));
  const notAccepted = decisions.filter((d) => !d.review || d.review.decision === 'held');
  if (notAccepted.length > 0)
    return { kind: 'held', revision, holdCode: 'findings-not-reviewed', detail: notAccepted.map((d) => `${d.finding.id}:${d.review ? 'held' : 'unreviewed'}`) };

  if (!ELIGIBLE_STATUS.has(lab.status) || lab.assay.state !== 'provided')
    return { kind: 'held', revision, holdCode: 'unsupported-source', detail: [!ELIGIBLE_STATUS.has(lab.status) ? `status:${lab.status}` : 'assay:not-provided'] };

  const geneInputs: GeneInput[] = [];
  const unsupported: string[] = [];
  const uncertain: string[] = [];
  for (const { finding: f, review } of decisions) {
    if (review!.decision === 'rejected') uncertain.push(`${f.id}:rejected`);
    else if (f.coverage !== 'tested' || f.analyticalState !== 'resolved' || f.interpretationState !== 'interpretable')
      uncertain.push(`${f.id}:${f.analyticalState}/${f.interpretationState}`);
    else if (f.reportedCall?.kind !== 'diplotype') unsupported.push(`${f.id}:${f.reportedCall?.kind ?? 'none'}`);
    else if (f.reportedCall.copyNumber !== null && f.reportedCall.copyNumber !== 2) unsupported.push(`${f.id}:copy-number`);
    else geneInputs.push({ gene: f.gene, state: 'diplotype', diplotype: f.reportedCall.value });
  }
  if (unsupported.length > 0) return { kind: 'held', revision, holdCode: 'unsupported-source', detail: unsupported };
  if (uncertain.length > 0) return { kind: 'held', revision, holdCode: 'unresolved-finding', detail: uncertain };
  return { kind: 'ready', revision, geneInputs, reviewIds: decisions.map((d) => d.review!.id).sort() };
}
