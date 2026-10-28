import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { evaluationExecutionProfileSchema, type EvaluationExecutionProfile } from '@telesphoros/shared-types';
import type { Env } from '../config/env';
import { assertNoUrlTls } from '../db/tls';

const number = (min: number, max: number, fallback: number) => z.coerce.number().int().min(min).max(max).default(fallback);

const schema = z.object({
  /** Off unless set. Nothing else starts this process's consumer. */
  EVALUATION_WORKER: z.enum(['disabled', 'enabled']).default('disabled'),
  /** The queue login (`telesphoros_worker` members only): it claims and reports jobs. The evaluation itself is written with DATABASE_URL, as the API writes it. */
  EVALUATION_WORKER_DATABASE_URL: z.string().min(1).optional(),
  /** The one execution profile this worker runs, as JSON: a request pinned to any other is refused, never answered. */
  EVALUATION_EXECUTION_PROFILE: z.string().min(1).optional(),
  WORKER_ID: z
    .string()
    .regex(/^[A-Za-z0-9._:-]{1,96}$/)
    .optional(),
  /** Reads run one at a time per slot of the reader limiter anyway; more than a few claims would only hold leases while waiting. */
  EVALUATION_WORKER_CONCURRENCY: number(1, 8, 1),
  EVALUATION_WORKER_TENANT_CAP: number(1, 50, 1),
  EVALUATION_WORKER_POLL_MS: number(50, 60_000, 2_000),
  EVALUATION_WORKER_DRAIN_SECONDS: number(0, 600, 30),
});

export interface EvaluationWorkerConfig {
  queueDatabaseUrl: string;
  profile: EvaluationExecutionProfile;
  workerId: string;
  concurrency: number;
  tenantCap: number;
  pollMs: number;
  drainSeconds: number;
}

/**
 * H3: the settings of the evaluation-request worker (src/evaluation-worker.ts). Refuses to start unless it is switched on, the lab-report pipeline it runs is
 * enabled (which the application already refuses in production: it is a synthetic integration), and the queue login is not the application login.
 * Every refusal names the setting, never its value.
 */
export function loadEvaluationWorkerConfig(
  env: Env,
  source: NodeJS.ProcessEnv = process.env,
  hostname = 'evaluation-worker',
  pid = process.pid,
  instance = randomUUID().slice(0, 8),
): EvaluationWorkerConfig {
  const parsed = schema.safeParse(source);
  if (!parsed.success) throw new Error(`Evaluation worker settings are invalid: ${[...new Set(parsed.error.issues.map((i) => i.path.join('.') || 'environment'))].join(', ')}.`);
  const c = parsed.data;
  if (c.EVALUATION_WORKER !== 'enabled') throw new Error('EVALUATION_WORKER is not enabled.');
  if (env.LAB_REPORT_PIPELINE !== 'enabled') throw new Error('EVALUATION_WORKER needs LAB_REPORT_PIPELINE=enabled.');
  if (!c.EVALUATION_WORKER_DATABASE_URL) throw new Error('EVALUATION_WORKER_DATABASE_URL is required.');
  if (c.EVALUATION_WORKER_DATABASE_URL === env.DATABASE_URL) throw new Error('EVALUATION_WORKER_DATABASE_URL must be the queue login, not the application login (DATABASE_URL).');
  assertNoUrlTls(c.EVALUATION_WORKER_DATABASE_URL, 'EVALUATION_WORKER_DATABASE_URL');
  let profile: EvaluationExecutionProfile;
  try {
    profile = evaluationExecutionProfileSchema.parse(JSON.parse(c.EVALUATION_EXECUTION_PROFILE ?? ''));
  } catch {
    throw new Error('EVALUATION_EXECUTION_PROFILE is missing or is not an execution profile.');
  }
  if (c.WORKER_ID === undefined && !/^[A-Za-z0-9._-]{1,64}$/.test(hostname)) throw new Error('Set WORKER_ID: the host name is not a short code.');
  return {
    queueDatabaseUrl: c.EVALUATION_WORKER_DATABASE_URL,
    profile,
    // PID 1 in every container and a shared host name would give every task the same id (and one job_workers row), as in apps/worker/src/config.ts.
    workerId: c.WORKER_ID ?? `${hostname}:${pid}:${instance}`,
    concurrency: c.EVALUATION_WORKER_CONCURRENCY,
    tenantCap: c.EVALUATION_WORKER_TENANT_CAP,
    pollMs: c.EVALUATION_WORKER_POLL_MS,
    drainSeconds: c.EVALUATION_WORKER_DRAIN_SECONDS,
  };
}

/**
 * The profile a process is configured with (the worker, H3; the API's queued requests, H4) must be what it actually loaded: the knowledge set and the recordings are checked here, at start-up, because
 * the database would otherwise refuse every completion one at a time (migration 0051). The code artifact and execution manifest digests are taken as
 * configured: nothing in this process can recompute them yet.
 */
export function assertRunsProfile(profile: EvaluationExecutionProfile, loaded: { knowledgeSetId: string; recordingsSha256: string }): void {
  if (profile.knowledgeSetId !== loaded.knowledgeSetId) throw new Error('EVALUATION_EXECUTION_PROFILE names a knowledge set this process did not load.');
  if (profile.recordingsSha256 !== loaded.recordingsSha256) throw new Error('EVALUATION_EXECUTION_PROFILE names recordings this process did not load.');
}
