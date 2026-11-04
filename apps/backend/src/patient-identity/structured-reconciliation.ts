import { findSyntheticPgxRevisionConflicts, inspectSyntheticPgxLineage, type StructuredRecordState } from '@telesphoros/shared-types';
import type { StoredStructuredRevision, StructuredSnapshot } from '../storage/structured-revisions.repository';

const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

/**
 * Pure reconciliation of one patient's complete stored set: conflicts, the resolutions still current, and each source's disposition. The
 * records service shows it and the synthetic assessment reads it, so what a reviewer saw as open for review is exactly what an assessment
 * may rest on.
 */
export function reconcileStructured(tenantId: string, patientId: string, snapshot: StructuredSnapshot) {
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
