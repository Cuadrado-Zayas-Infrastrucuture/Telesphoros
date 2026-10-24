import type { AddressInfo } from 'node:net';
import { S3Client } from '@aws-sdk/client-s3';
import { Pool } from 'pg';
import { JobQueue } from '@telesphoros/jobs';
import { pgClientConfig } from '../../backend/src/db/tls';
import { loadConfig, type WorkerConfig } from './config';
import type { HandlerDeps } from './deps';
import { startHealthServer } from './health';
import { filesVerifyJobs } from './handlers/files-verify';
import { testJobs } from './handlers/test-jobs';
import { uploadsSweepJob } from './handlers/uploads-sweep';
import { PgJobData } from './job-data';
import { jsonLogger } from './log';
import { WORKER_POOL_LIMITS } from './pool-limits';
import { Runner, type RegisteredJob } from './runner';
import { Ticker } from './scheduler';
import { createShutdown, shutdownDeadlineMs } from './shutdown';
import { S3ObjectInspector } from './storage';

/**
 * Production consumers are registered here, one reviewed line per job type. The upload sweep needs only the database; the stored-file re-check also needs the
 * bucket (read-only) and is not registered without one (a production worker refuses to start without it, config.ts). The test job types are registered only
 * when WORKER_TEST_JOBS=yes outside production.
 */
function registeredJobs(config: WorkerConfig, deps: HandlerDeps): RegisteredJob[] {
  const jobs: RegisteredJob[] = [uploadsSweepJob(deps)];
  if (config.reportsBucket) jobs.push(...filesVerifyJobs(deps));
  else deps.log('warn', 'job-types-disabled', { reason: 'no-reports-bucket' });
  if (config.testJobs) jobs.push(...testJobs(config.testEffectDir as string));
  return jobs;
}

async function main(): Promise<void> {
  const log = jsonLogger();
  const config = loadConfig();
  const pool = new Pool({ ...pgClientConfig(config.databaseUrl, config.databaseTls), ...WORKER_POOL_LIMITS, max: config.concurrency + 3, application_name: 'telesphoros-worker' });
  pool.on('error', () => log('error', 'database-connection-error', { code: 'pool-error' }));
  const queue = new JobQueue(pool);
  const s3 = new S3Client({ ...(config.awsRegion ? { region: config.awsRegion } : {}), ...(config.s3Endpoint ? { endpoint: config.s3Endpoint } : {}), forcePathStyle: config.s3ForcePathStyle });
  const deps: HandlerDeps = { data: new PgJobData(pool), inspector: new S3ObjectInspector(s3, config.reportsBucket ?? 'unconfigured'), log };
  const jobs = registeredJobs(config, deps);
  const runner = new Runner({ workerId: config.workerId, queue, jobs, concurrency: config.concurrency, tenantCap: config.tenantCap, pollMs: config.pollMs, drainSeconds: config.drainSeconds, log });
  const scheduler = new Ticker('schedule', () => queue.scheduleTick(), config.scheduleTickSeconds, log);
  const relay = new Ticker('outbox-relay', () => queue.relayOutbox(), config.relaySeconds, log);
  // The queue's depth and the age of its oldest ready job, as one log line a minute: the "queue is not draining" alarm reads `ageSeconds` (suspended organizations'
  // jobs are not counted: they are held on purpose).
  const stats = new Ticker('queue-stats', async () => {
    const rows = await queue.stats();
    const outbox = await queue.outboxStats();
    const waiting = rows.filter((r) => r.state === 'queued' || r.state === 'retry');
    log('info', 'queue-stats', {
      count: waiting.reduce((n, r) => n + r.count, 0),
      running: rows.filter((r) => r.state === 'running').reduce((n, r) => n + r.count, 0),
      dead: rows.filter((r) => r.state === 'dead').reduce((n, r) => n + r.count, 0),
      ageSeconds: Math.round(Math.max(0, ...waiting.map((r) => r.oldestReadySeconds ?? 0))),
      outboxPending: outbox.pending,
      outboxAgeSeconds: Math.round(outbox.oldestPendingSeconds ?? 0),
    });
    return 0;
  }, config.statsSeconds, log);
  runner.start();
  scheduler.start();
  relay.start();
  stats.start();
  const health = await startHealthServer(runner, { host: config.healthHost, port: config.healthPort, staleAfterMs: Math.max(30_000, config.pollMs * 5) });
  log('info', 'health-listening', { count: (health.address() as AddressInfo).port });

  const shutdown = createShutdown({
    closeHealth: () => {
      health.close();
      health.closeAllConnections();
    },
    tickers: [scheduler, relay, stats],
    runner,
    closePool: () => pool.end().catch(() => undefined),
    log,
    exit: (code) => process.exit(code),
    deadlineMs: shutdownDeadlineMs(config.drainSeconds),
  });
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  // A start-up refusal names the setting that is wrong (config.ts), never a value.
  process.stderr.write(`worker failed to start: ${error instanceof Error ? error.message : 'unknown error'}\n`);
  process.exit(1);
});
