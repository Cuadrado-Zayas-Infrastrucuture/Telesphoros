import type { ReportRecord } from '../storage/records';
import type { Projected } from '../storage/ledger-records';

/** Where a report's link to its patient stands for the file it holds NOW. */
export interface LinkState {
  state: 'unverified' | 'verified' | 'rejected';
  /** The newest decision, whether or not it still applies. */
  decision: Projected | null;
  /** A decision exists but was made about another file or patient than the report has now. */
  stale: boolean;
}

/**
 * The state is derived, never stored: the newest decision for the report counts only if it names the report's current file (hash and storage
 * version) and patient. A report whose file is replaced is therefore unverified again without anyone having to remember to reset it.
 */
export function linkState(report: ReportRecord, newest: Projected | undefined): LinkState {
  if (!newest) return { state: 'unverified', decision: null, stale: false };
  const applies = !!report.sha256 && !!report.objectVersion && newest.reportSha256 === report.sha256 && newest.objectVersion === report.objectVersion && newest.patientId === report.patientId;
  if (!applies) return { state: 'unverified', decision: newest, stale: true };
  return { state: newest.decision === 'verified' ? 'verified' : 'rejected', decision: newest, stale: false };
}
