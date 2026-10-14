import { createHash } from 'node:crypto';
import { tenantPrefix } from '../../lab-reports/object-keys';
import type { Env } from '../../config/env';
import type { ReportsRepository } from '../../storage/reports.repository';
import type { UploadAttempt } from '../../storage/upload-attempt';

/**
 * Where one report's intake attempts live: the reservation scope (`runId`), the object key of an attempt, and the part of the bucket that must hold
 * nothing but known attempts before a new one may start.
 *
 * - Local run (LOCAL_STORAGE_RUN_ID set): the disposable synthetic run of L1. One scope for the whole run, keys `local-storage/<run>/<attempt>`.
 * - Organization (no run id, M2.2a): the scope is the organization (a fixed id derived from it, so its quota is shared by all its reports) and the
 *   keys are `reports/<tenant hash>/<report id>/intake/<attempt>`. The inventory is per report, so it stays small however much the organization holds,
 *   and it never meets the legacy keys (`reports/<tenant hash>/<report id>/<random>`) or the captured text (`.../text/...`).
 */
export interface IntakeScope {
  readonly kind: 'local-run' | 'organization';
  readonly runId: string;
  /** Everything under this prefix must be a known attempt of this scope before a new attempt is declared. */
  readonly prefix: string;
  keyFor(attemptId: string): string;
  known(reports: ReportsRepository): Promise<UploadAttempt[]>;
}

/** A stable UUID for an organization's reservation scope (the column is a uuid; the value carries no meaning). */
export function organizationRunId(tenantId: string): string {
  const b = createHash('sha256').update(`telesphoros-intake-scope:${tenantId}`).digest().subarray(0, 16);
  b[6] = (b[6]! & 0x0f) | 0x50;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function intakeScope(env: Pick<Env, 'LOCAL_STORAGE_RUN_ID'>, tenantId: string, reportId: string): IntakeScope {
  const run = env.LOCAL_STORAGE_RUN_ID;
  if (run) {
    const prefix = `local-storage/${run}/`;
    return { kind: 'local-run', runId: run, prefix, keyFor: (id) => `${prefix}${id}`, known: (r) => r.runAttempts(tenantId, run) };
  }
  const prefix = `reports/${tenantPrefix(tenantId)}/${reportId}/intake/`;
  return { kind: 'organization', runId: organizationRunId(tenantId), prefix, keyFor: (id) => `${prefix}${id}`, known: (r) => r.reportAttempts(tenantId, reportId) };
}
