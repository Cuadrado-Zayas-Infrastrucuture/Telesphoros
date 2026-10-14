import type { AddressInfo } from 'node:net';
import { Pool } from 'pg';
import { JobQueue } from '@telesphoros/jobs';
import { pgClientConfig } from '../../backend/src/db/tls';
import { loadConfig } from './config';
import { startHealthServer } from './health';
import { testJobs } from './handlers/test-jobs';
import { jsonLogger } from './log';
import { Runner, type RegisteredJob } from './runner';
import { Scheduler } from './scheduler';

/**
 * Production consumers are registered here, one reviewed line per job type (M2.3b adds the first two). This slice registers none: the worker can run
 * only the test jobs, and only when WORKER_TEST_JOBS=yes outside production.
 */
function registeredJobs(config: ReturnType<typeof loadConfig>): RegisteredJob[] {
  return config.testJobs ? testJobs(config.testEffectDir as string) : [];
}

async function main(): Promise<void> {
  const log = jsonLogger();
  const config = loadConfig();
  const jobs = registeredJobs(config);
  if (jobs.length === 0) {
    log('warn', 'worker-idle', { workerId: config.workerId, reason: 'no-job-types' });
    // Nothing to run yet: stay up and healthy so the service can be deployed ahead of its first consumer, without claiming anything.
  }
  const pool = new Pool({ ...pgClientConfig(config.databaseUrl, config.databaseTls), max: config.concurrency + 3, application_name: 'telesphoros-worker' });
  pool.on('error', () => log('error', 'database-connection-error', { code: 'pool-error' }));
  const queue = new JobQueue(pool);
  const runner = jobs.length > 0 ? new Runner({ workerId: config.workerId, queue, jobs, concurrency: config.concurrency, tenantCap: config.tenantCap, pollMs: config.pollMs, drainSeconds: config.drainSeconds, log }) : undefined;
  const scheduler = new Scheduler(queue, config.scheduleTickSeconds, log);
  runner?.start();
  if (runner) scheduler.start();
  const health = runner
    ? await startHealthServer(runner, { host: config.healthHost, port: config.healthPort, staleAfterMs: Math.max(30_000, config.pollMs * 5) })
    : undefined;

  if (health) log('info', 'health-listening', { count: (health.address() as AddressInfo).port });

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log('info', 'shutdown-requested', { reason: signal });
    health?.close();
    await scheduler.stop();
    await runner?.stop();
    await pool.end().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  if (!runner) await new Promise<void>(() => undefined);
}

main().catch((error: unknown) => {
  // A start-up refusal names the setting that is wrong (config.ts), never a value.
  process.stderr.write(`worker failed to start: ${error instanceof Error ? error.message : 'unknown error'}\n`);
  process.exit(1);
});
