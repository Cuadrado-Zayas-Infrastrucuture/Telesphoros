import { fatal, filesVerifyStale, filesVerifyStored, retryable } from '@telesphoros/jobs';
import type { HandlerDeps, VerifyOutcome, VerifyTarget } from '../deps';
import type { RegisteredJob } from '../runner';

/** How many of an organization's reports one scheduled run re-checks, and how long a check stays fresh. */
export const STALE_BATCH = 25;
export const STALE_AFTER_SECONDS = 30 * 24 * 3600;

interface Verdict {
  outcome: VerifyOutcome;
  reason?: string;
}

const sameType = (a: string | undefined, b: string) => (a ?? '').split(';')[0]!.trim().toLowerCase() === b.split(';')[0]!.trim().toLowerCase();

/** Compares the stored version with the facts the report is pinned to. A failure is a finding, recorded as such; nothing is repaired or deleted here. An abort is not a finding. */
async function check(deps: HandlerDeps, target: VerifyTarget, signal: AbortSignal): Promise<Verdict> {
  let found;
  try {
    found = await deps.inspector.inspect(target.storageKey, target.objectVersion, { maxBytes: target.sizeBytes, signal });
  } catch {
    // A read cut short because the job was told to stop (timeout, shutdown, lost lease) says nothing about the store. Recording it would leave an
    // append-only `unreadable` finding, and an alarm, for a file nobody could read; the job is retried instead.
    if (signal.aborted) throw retryable('handler-aborted');
    return { outcome: 'unreadable', reason: 'storage-error' };
  }
  if (found === 'missing') return { outcome: 'missing', reason: 'version-missing' };
  if (found === 'too-large') return { outcome: 'changed', reason: 'size-mismatch' };
  if (found.sizeBytes !== target.sizeBytes) return { outcome: 'changed', reason: 'size-mismatch' };
  if (found.sha256 !== target.sha256) return { outcome: 'changed', reason: 'hash-mismatch' };
  if (!sameType(found.contentType, target.contentType)) return { outcome: 'changed', reason: 'type-mismatch' };
  return { outcome: 'ok' };
}

async function verifyAndRecord(deps: HandlerDeps, jobId: string, workerId: string, target: VerifyTarget, signal: AbortSignal): Promise<Verdict> {
  const verdict = await check(deps, target, signal);
  await deps.data.recordVerification(jobId, workerId, target.reportId, verdict.outcome, verdict.reason, target.objectVersion);
  return verdict;
}

/** The error a failed check ends the job with: a finding is dead at once (visible in `jobs dead`, an alarm in M2.3c), never retried; a read failure is retried. */
function failure(verdicts: Verdict[]) {
  if (verdicts.some((v) => v.outcome === 'missing')) return fatal('file-missing');
  if (verdicts.some((v) => v.outcome === 'changed')) return fatal('file-changed');
  return retryable('storage-unreadable');
}

export function filesVerifyJobs(deps: HandlerDeps): RegisteredJob[] {
  return [
    {
      definition: filesVerifyStored,
      handler: async ({ job, workerId, signal }) => {
        const target = await deps.data.verifyTarget(job.id, workerId);
        if (!target) return; // the report has no uploaded file any more: nothing to check
        const verdict = await verifyAndRecord(deps, job.id, workerId, target, signal);
        deps.log(verdict.outcome === 'ok' ? 'info' : 'error', 'file-verified', { jobId: job.id, jobType: job.type, outcome: verdict.outcome, code: verdict.reason });
        if (verdict.outcome !== 'ok') throw failure([verdict]);
      },
    },
    {
      definition: filesVerifyStale,
      handler: async ({ job, workerId, signal }) => {
        const targets = await deps.data.verifyStale(job.id, workerId, STALE_BATCH, STALE_AFTER_SECONDS);
        const bad: Verdict[] = [];
        for (const target of targets) {
          if (signal.aborted) throw retryable('handler-aborted'); // the rest is picked up by the next run: unchecked reports come first
          const verdict = await verifyAndRecord(deps, job.id, workerId, target, signal);
          if (verdict.outcome !== 'ok') bad.push(verdict);
        }
        deps.log(bad.length ? 'error' : 'info', 'files-reverified', { jobId: job.id, jobType: job.type, count: targets.length, running: bad.length });
        if (bad.length) throw failure(bad);
      },
    },
  ];
}
