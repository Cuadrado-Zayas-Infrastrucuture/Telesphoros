import { z } from 'zod';
import { tenantIdSchema } from './tenant';
import { syntheticPgxLabReportSchema } from './synthetic-pgx';

const snapshotSchema = z.strictObject({
  tenantId: tenantIdSchema,
  patientId: z.uuid(),
  sources: z
    .array(
      z.strictObject({
        sourceId: z.uuid(),
        tenantId: tenantIdSchema,
        patientId: z.uuid(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        objectVersion: z.string().min(1).max(1024),
        report: syntheticPgxLabReportSchema,
      }),
    )
    .max(100),
});
type Source = z.infer<typeof snapshotSchema>['sources'][number];
export type SyntheticPgxLineageReason =
  | 'duplicate-revision-content'
  | 'report-id-reused'
  | 'accession-reused'
  | 'source-patient-mismatch'
  | 'accession-mismatch'
  | 'specimen-mismatch'
  | 'revision-gap'
  | 'predecessor-mismatch'
  | 'issue-time-reversal'
  | 'terminal-revision-has-successor'
  | 'latest-status-ineligible';

export type SyntheticPgxLineageSeries = {
  laboratoryId: string;
  seriesId: string;
  state: 'candidate-for-review' | 'held';
  reasons: SyntheticPgxLineageReason[];
  revisions: { revision: number; reportIds: string[]; sources: Pick<Source, 'sourceId' | 'sha256' | 'objectVersion'>[] }[];
  candidate: { reportId: string; revision: number; sourceIds: string[]; findingIds: string[] } | null;
};

export type SyntheticPgxLineageInspection = {
  policyVersion: 'pgx-lineage-synthetic-0.1';
  synthetic: true;
  clinicalUse: 'not-approved';
  actionable: false;
  independentReviewRequired: true;
  profileState: 'not-reconciled';
  series: SyntheticPgxLineageSeries[];
};

// Only schema-parsed values reach this comparison; object keys are irrelevant, array order and text are not.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).sort(([a], [b]) => compare(a, b));
    return `{${entries.map(([key, v]) => `${JSON.stringify(key)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const seriesKey = (s: Source) => JSON.stringify([s.report.laboratoryId, s.report.seriesId]);
const distinct = (values: string[]) => [...new Set(values)].sort(compare);
const terminal = (s: Source) => ['cancelled', 'entered-in-error'].includes(s.report.status);

/**
 * Inspect already authorized, byte-verified synthetic source snapshots. This pure function performs no I/O,
 * authenticates no issuer, grants no review acceptance and never constructs a reconciled patient profile.
 * Recompute against the transaction's complete source set before any future persistence/current-basis decision.
 */
export function inspectSyntheticPgxLineage(input: unknown): SyntheticPgxLineageInspection {
  const invalid = () => new Error('Invalid synthetic lineage snapshot.');
  // Bound the collection before Zod walks its members. Each member has the finite S1 field/array limits.
  if (!input || typeof input !== 'object' || !('sources' in input) || !Array.isArray(input.sources) || input.sources.length > 100) throw invalid();
  const parsed = snapshotSchema.safeParse(input);
  if (!parsed.success) throw invalid();
  const { tenantId, patientId, sources } = parsed.data;
  if (sources.some((s) => s.tenantId !== tenantId || s.patientId !== patientId) || new Set(sources.map((s) => s.sourceId)).size !== sources.length) throw invalid();

  const groups = new Map<string, Source[]>();
  for (const s of sources) {
    const key = seriesKey(s);
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  const series = [...groups.entries()]
    .sort(([a], [b]) => compare(a, b))
    .map(([key, members]): SyntheticPgxLineageSeries => {
      const ordered = [...members].sort((a, b) => a.report.revision - b.report.revision || compare(a.sourceId, b.sourceId));
      const first = ordered[0];
      const reasons = new Set<SyntheticPgxLineageReason>();
      const byRevision = new Map<number, Source[]>();
      for (const s of ordered) {
        const r = s.report;
        byRevision.set(r.revision, [...(byRevision.get(r.revision) ?? []), s]);
        if (r.patientId !== first.report.patientId) reasons.add('source-patient-mismatch');
        if (r.accession !== first.report.accession) reasons.add('accession-mismatch');
        if (canonical(r.specimen) !== canonical(first.report.specimen)) reasons.add('specimen-mismatch');
        // Same issuer's IDs cannot be reassigned to a different series/revision, even when uploaded out of order.
        for (const other of sources) {
          if (other.report.laboratoryId !== r.laboratoryId) continue;
          if (other.report.id === r.id && (seriesKey(other) !== key || other.report.revision !== r.revision)) reasons.add('report-id-reused');
          if (other.report.accession === r.accession && seriesKey(other) !== key) reasons.add('accession-reused');
        }
      }
      const revisions = [...byRevision.entries()].map(([revision, items]) => ({
        revision,
        reportIds: distinct(items.map((s) => s.report.id)),
        sources: items.map(({ sourceId, sha256, objectVersion }) => ({ sourceId, sha256, objectVersion })),
      }));
      const representatives = [...byRevision.values()].map((items) => {
        const exemplar = items[0];
        const content = canonical(exemplar.report);
        if (items.some((s) => s.sha256 !== exemplar.sha256 || canonical(s.report) !== content)) reasons.add('duplicate-revision-content');
        return exemplar;
      });
      representatives.forEach((s, index) => {
        const previous = representatives[index - 1];
        if (s.report.revision !== index + 1) reasons.add('revision-gap');
        if (!previous) return;
        if (s.report.previousRevisionId !== previous.report.id) reasons.add('predecessor-mismatch');
        if (Date.parse(s.report.issuedAt) < Date.parse(previous.report.issuedAt)) reasons.add('issue-time-reversal');
        if (terminal(previous)) reasons.add('terminal-revision-has-successor');
      });
      const latest = representatives[representatives.length - 1];
      if (!['final', 'amended', 'corrected'].includes(latest.report.status)) reasons.add('latest-status-ineligible');
      return {
        laboratoryId: first.report.laboratoryId,
        seriesId: first.report.seriesId,
        state: reasons.size ? 'held' : 'candidate-for-review',
        reasons: [...reasons].sort(compare),
        revisions,
        candidate: reasons.size
          ? null
          : {
              reportId: latest.report.id,
              revision: latest.report.revision,
              sourceIds: byRevision.get(latest.report.revision)!.map((s) => s.sourceId),
              findingIds: latest.report.findings.map((f) => f.id),
            },
      };
    });
  return {
    policyVersion: 'pgx-lineage-synthetic-0.1',
    synthetic: true,
    clinicalUse: 'not-approved',
    actionable: false,
    independentReviewRequired: true,
    profileState: 'not-reconciled',
    series,
  };
}

export type SyntheticPgxRevisionConflict = { laboratoryId: string; seriesId: string; revision: number; sourceIds: string[] };

/**
 * The same-revision conflicts behind a `duplicate-revision-content` hold: one laboratory revision stored from sources whose bytes or
 * content differ. Identical bytes uploaded twice are separate provenance, not a conflict. Pure; names the sources, never picks one.
 */
export function findSyntheticPgxRevisionConflicts(input: unknown): SyntheticPgxRevisionConflict[] {
  inspectSyntheticPgxLineage(input); // same bounds, tenant and patient checks
  const { sources } = snapshotSchema.parse(input);
  const groups = new Map<string, Source[]>();
  for (const s of sources) {
    const key = JSON.stringify([s.report.laboratoryId, s.report.seriesId, s.report.revision]);
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => compare(a, b))
    .flatMap(([, items]) => {
      const first = items[0];
      const content = canonical(first.report);
      if (!items.some((s) => s.sha256 !== first.sha256 || canonical(s.report) !== content)) return [];
      return [{ laboratoryId: first.report.laboratoryId, seriesId: first.report.seriesId, revision: first.report.revision, sourceIds: distinct(items.map((s) => s.sourceId)) }];
    });
}
