import { uploadsSweep } from '@telesphoros/jobs';
import type { HandlerDeps } from '../deps';
import type { RegisteredJob } from '../runner';

/**
 * `uploads.sweep`: closes the organization's abandoned upload attempts and returns their quota, exactly as `uploads sweep` does for an operator (the same database
 * function). Idempotent: a second run finds nothing more. Deletes nothing from the bucket.
 */
export function uploadsSweepJob(deps: HandlerDeps): RegisteredJob {
  return {
    definition: uploadsSweep,
    handler: async ({ job, workerId }) => {
      const result = await deps.data.sweepUploads(job.id, workerId);
      deps.log('info', 'uploads-swept', { jobId: job.id, jobType: job.type, count: result.released });
    },
  };
}
