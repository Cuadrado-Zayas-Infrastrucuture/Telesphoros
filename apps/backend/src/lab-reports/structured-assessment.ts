import type { GeneInput } from '@telesphoros/cpic-schema';
import { reconcileStructured } from '../patient-identity/structured-reconciliation';
import type { StoredStructuredRevision, StructuredSnapshot } from '../storage/structured-revisions.repository';
import type { StructuredHoldCode } from './structured-hold-codes';

/** A gene's phenotype as the laboratory reported it, used as the engine's input (spec 044 K2-D2); stored in the evaluation's binding. */
export interface LabPhenotypeSource {
  findingId: string;
  gene: string;
  translationVersion: string;
}

export type StructuredAssessmentPlan =
  /** Nothing is stored: the evidence is not what the reviewer saw, or this revision is not the one under review. */
  | { kind: 'refused'; reason: 'not-recorded' | 'source-changed' | 'superseded' }
  /** Stored as a held evaluation with no result. `detail` names codes only, never a value from the report. */
  | { kind: 'held'; revision: StoredStructuredRevision; holdCode: StructuredHoldCode; detail: string[] }
  | { kind: 'ready'; revision: StoredStructuredRevision; geneInputs: GeneInput[]; reviewIds: string[]; labPhenotypes: LabPhenotypeSource[] };

/** What the plan reads from the loaded knowledge: a gene's map, to tell a phenotype-only map (no alleles, no method) and its canonical terms. */
export interface PlanKnowledge {
  gene(symbol: string): { phenotypes: readonly string[]; alleles?: unknown; method?: unknown } | undefined;
}

const ELIGIBLE_STATUS = new Set(['final', 'amended', 'corrected']);

/**
 * Decides what a stored structured revision may be assessed on. Pure: the same snapshot and knowledge give the same plan. It never infers: a finding
 * that is unreviewed, rejected, uncertain or not tested stops the whole revision. A finding's gene is read from its resolved diplotype, and the
 * laboratory's own phenotype is never used in place of the knowledge set's mapping from the diplotype. The one exception (spec 044, decision K2-D2) is a
 * gene whose loaded map is phenotype-only, so has no mapping to use: then the laboratory's phenotype is the input, and only if it is exactly one of the
 * map's terms (no translation, no case folding); anything else holds the revision. Holds are ranked: a conflict first (nothing about the sources is
 * settled), then findings no second person has accepted, then an unsupported kind of source, then findings that are uncertain.
 */
export function planStructuredAssessment(
  tenantId: string,
  report: { id: string; patientId: string },
  snapshot: StructuredSnapshot,
  knowledge?: PlanKnowledge,
): StructuredAssessmentPlan {
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
  // Every check below reads "each finding is ...", which an empty list passes: a report with no findings would be assessed with no person having reviewed anything.
  if (lab.findings.length === 0) return { kind: 'held', revision, holdCode: 'unsupported-source', detail: ['no-findings'] };
  const decisions = lab.findings.map((f) => ({ finding: f, review: snapshot.reviews.find((x) => x.revisionId === revision.id && x.findingId === f.id) }));
  const notAccepted = decisions.filter((d) => !d.review || d.review.decision === 'held');
  if (notAccepted.length > 0)
    return { kind: 'held', revision, holdCode: 'findings-not-reviewed', detail: notAccepted.map((d) => `${d.finding.id}:${d.review ? 'held' : 'unreviewed'}`) };

  if (!ELIGIBLE_STATUS.has(lab.status) || lab.assay.state !== 'provided')
    return { kind: 'held', revision, holdCode: 'unsupported-source', detail: [!ELIGIBLE_STATUS.has(lab.status) ? `status:${lab.status}` : 'assay:not-provided'] };

  const geneInputs: GeneInput[] = [];
  const labPhenotypes: LabPhenotypeSource[] = [];
  const unsupported: string[] = [];
  const uncertain: string[] = [];
  for (const { finding: f, review } of decisions) {
    const map = knowledge?.gene(f.gene);
    if (review!.decision === 'rejected') uncertain.push(`${f.id}:rejected`);
    else if (f.coverage !== 'tested' || f.analyticalState !== 'resolved' || f.interpretationState !== 'interpretable')
      uncertain.push(`${f.id}:${f.analyticalState}/${f.interpretationState}`);
    else if (map !== undefined && map.alleles === undefined && map.method === undefined) {
      // K2-D2: a phenotype-only map cannot read a diplotype, so the laboratory's phenotype is the input, exactly as the map names it, or nothing.
      const interpretation = f.laboratoryInterpretation;
      const phenotype = interpretation?.phenotype ?? null;
      if (interpretation === null || phenotype === null || !map.phenotypes.includes(phenotype)) unsupported.push(`${f.id}:phenotype-not-in-map`);
      else {
        geneInputs.push({ gene: f.gene, state: 'canonical', phenotype, callSource: 'lab-report' });
        labPhenotypes.push({ findingId: f.id, gene: f.gene, translationVersion: interpretation.translationVersion });
      }
    } else if (f.reportedCall?.kind !== 'diplotype') unsupported.push(`${f.id}:${f.reportedCall?.kind ?? 'none'}`);
    else if (f.reportedCall.copyNumber !== null && f.reportedCall.copyNumber !== 2) unsupported.push(`${f.id}:copy-number`);
    else geneInputs.push({ gene: f.gene, state: 'diplotype', diplotype: f.reportedCall.value });
  }
  if (unsupported.length > 0) return { kind: 'held', revision, holdCode: 'unsupported-source', detail: unsupported };
  if (uncertain.length > 0) return { kind: 'held', revision, holdCode: 'unresolved-finding', detail: uncertain };
  return { kind: 'ready', revision, geneInputs, reviewIds: decisions.map((d) => d.review!.id).sort(), labPhenotypes };
}
