import { defineJob, fatal, systemActor, type ClaimedJob } from '@telesphoros/jobs';
import { z } from 'zod';
import { SYNTHETIC_JOB_TYPE, type DurableSyntheticStore } from './contracts';
import { runDurableSynthetic, type ScriptedActors } from './kernel';
import type { SyntheticJobQueue } from './queue';

const payload = z.strictObject({ runId: z.uuid() });
const definition = defineJob({ type: SYNTHETIC_JOB_TYPE, payload,
  maxAttempts: 1, leaseSeconds: 15, timeoutSeconds: 120, testOnly: true });

/** Explicit test registration only. Import or factory creation does not start a Runner or a database. */
export function syntheticTestJob(queue: SyntheticJobQueue, store: DurableSyntheticStore, actors: ScriptedActors) {
  return { definition, handler: async (context: { job: ClaimedJob; actor: string; workerId: string; signal: AbortSignal }): Promise<void> => {
    if (context.actor !== systemActor(SYNTHETIC_JOB_TYPE) || context.job.type !== SYNTHETIC_JOB_TYPE) throw fatal('synthetic-binding');
    const parsed = payload.safeParse(context.job.payload);
    const claim = queue.claimFor(context.job.id, context.workerId);
    if (!parsed.success || !claim || claim.stamp.runId !== parsed.data.runId ||
      context.job.attempt !== claim.stamp.queueAttempt || context.signal.aborted) throw fatal('synthetic-stale');
    const outcome = await runDurableSynthetic(claim.stamp, claim.expected, store, actors, context.signal);
    if (outcome.kind === 'refused') throw fatal('synthetic-held');
  } };
}
