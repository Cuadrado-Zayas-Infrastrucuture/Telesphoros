import { z } from 'zod';
import { assertNoUrlTls, tlsFromEnv, type DatabaseTls } from '../../backend/src/db/tls';

const number = (min: number, max: number, fallback: number) => z.coerce.number().int().min(min).max(max).default(fallback);

const schema = z.object({
  /** The worker's own login (`telesphoros_worker` members only): it can call the queue functions and read the job tables, nothing else. */
  DATABASE_URL: z.string().min(1),
  WORKER_ID: z
    .string()
    .regex(/^[A-Za-z0-9._:-]{1,96}$/)
    .optional(),
  WORKER_CONCURRENCY: number(1, 50, 4),
  /** At most this many running jobs for one organization, across all workers. */
  WORKER_TENANT_CAP: number(1, 50, 2),
  WORKER_POLL_MS: number(50, 60_000, 2_000),
  /** How long a stop signal lets running jobs finish before the rest are released. */
  WORKER_DRAIN_SECONDS: number(0, 600, 30),
  WORKER_SCHEDULE_TICK_SECONDS: number(5, 3600, 30),
  /** How often pending outbox events are turned into jobs. */
  WORKER_RELAY_SECONDS: number(1, 600, 5),
  /** How often the worker logs the queue's depth and age (an alarm reads it). */
  WORKER_STATS_SECONDS: number(10, 3600, 60),
  /** The bucket the stored-file re-check reads (read-only). Required in production; without it the file jobs are not registered. */
  REPORTS_BUCKET: z
    .string()
    .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/)
    .optional(),
  S3_ENDPOINT: z.string().url().optional(),
  S3_FORCE_PATH_STYLE: z.enum(['true', 'false']).default('false'),
  AWS_REGION: z
    .string()
    .regex(/^[a-z0-9-]{2,32}$/)
    .optional(),
  WORKER_HEALTH_PORT: number(0, 65_535, 8081),
  WORKER_HEALTH_HOST: z.string().min(1).default('127.0.0.1'),
  /** Registers the test-only job types. Refused in production. */
  WORKER_TEST_JOBS: z.enum(['yes', 'no']).default('no'),
  /** Where the test handlers leave their markers (only with WORKER_TEST_JOBS=yes). */
  WORKER_TEST_EFFECT_DIR: z.string().optional(),
  NODE_ENV: z.string().optional(),
});

export interface WorkerConfig {
  databaseUrl: string;
  databaseTls: DatabaseTls;
  workerId: string;
  concurrency: number;
  tenantCap: number;
  pollMs: number;
  drainSeconds: number;
  scheduleTickSeconds: number;
  relaySeconds: number;
  statsSeconds: number;
  reportsBucket: string | undefined;
  s3Endpoint: string | undefined;
  s3ForcePathStyle: boolean;
  awsRegion: string | undefined;
  healthPort: number;
  healthHost: string;
  testJobs: boolean;
  testEffectDir: string | undefined;
}

/** Reads the environment. Every refusal names the setting, never its value. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, hostname = 'worker', pid = process.pid): WorkerConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) throw new Error(`Worker settings are invalid: ${[...new Set(parsed.error.issues.map((i) => i.path.join('.') || 'environment'))].join(', ')}.`);
  const c = parsed.data;
  assertNoUrlTls(c.DATABASE_URL, 'DATABASE_URL');
  const databaseTls = tlsFromEnv(env);
  const production = c.NODE_ENV === 'production';
  if (production && databaseTls === 'disable') throw new Error('A production worker must use DATABASE_SSL=require.');
  if (production && !c.REPORTS_BUCKET) throw new Error('A production worker needs REPORTS_BUCKET (the stored-file re-check reads it).');
  if (production && c.WORKER_TEST_JOBS === 'yes') throw new Error('Test jobs are refused in production.');
  if (c.WORKER_TEST_JOBS === 'yes' && !c.WORKER_TEST_EFFECT_DIR) throw new Error('WORKER_TEST_EFFECT_DIR is required with WORKER_TEST_JOBS=yes.');
  if (c.WORKER_ID === undefined && !/^[A-Za-z0-9._-]{1,64}$/.test(hostname)) throw new Error('Set WORKER_ID: the host name is not a short code.');
  return {
    databaseUrl: c.DATABASE_URL,
    databaseTls,
    workerId: c.WORKER_ID ?? `${hostname}:${pid}`,
    concurrency: c.WORKER_CONCURRENCY,
    tenantCap: c.WORKER_TENANT_CAP,
    pollMs: c.WORKER_POLL_MS,
    drainSeconds: c.WORKER_DRAIN_SECONDS,
    scheduleTickSeconds: c.WORKER_SCHEDULE_TICK_SECONDS,
    relaySeconds: c.WORKER_RELAY_SECONDS,
    statsSeconds: c.WORKER_STATS_SECONDS,
    reportsBucket: c.REPORTS_BUCKET,
    s3Endpoint: c.S3_ENDPOINT,
    s3ForcePathStyle: c.S3_FORCE_PATH_STYLE === 'true',
    awsRegion: c.AWS_REGION,
    healthPort: c.WORKER_HEALTH_PORT,
    healthHost: c.WORKER_HEALTH_HOST,
    testJobs: c.WORKER_TEST_JOBS === 'yes',
    testEffectDir: c.WORKER_TEST_EFFECT_DIR,
  };
}
