import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { Pool } from 'pg';
import { boundedStop, JobQueue, jsonLogger, Runner, shutdownDeadlineMs, WORKER_POOL_LIMITS } from '@telesphoros/jobs';
import { AppModule } from './app.module';
import { installProcessFaultHandlers } from './common/process-faults';
import { loadEnv } from './config/env';
import { Database } from './db/database';
import { pgClientConfig } from './db/tls';
import { EvaluationRequestConsumer, evaluationRequestJob } from './lab-reports/evaluation-request-consumer';
import { assertRunsProfile, loadEvaluationWorkerConfig } from './lab-reports/evaluation-worker-config';
import { EvaluationsService, LAB_KNOWLEDGE } from './lab-reports/evaluations.service';
import { TextCaptureRunner } from './lab-reports/runner/text-capture-runner';
import type { KnowledgeSet } from './services/knowledge/knowledge-set';

// First, so a fault during start-up or at any later point ends the process with one PHI-safe line instead of Node's default message and stack.
installProcessFaultHandlers(process, { service: 'evaluation-worker' });

/**
 * H3: the evaluation-request worker. The same application as the API (its EvaluationsService, reader, knowledge set and record log, writing as the
 * application login), without a listener, plus the shared job runner on the queue login. Off unless EVALUATION_WORKER=enabled; not part of any deployment.
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const config = loadEvaluationWorkerConfig(env);
  const app = await NestFactory.createApplicationContext(AppModule.register(env), { bufferLogs: true });
  app.useLogger(app.get(Logger));
  assertRunsProfile(config.profile, { knowledgeSetId: app.get<KnowledgeSet>(LAB_KNOWLEDGE).id, recordingsSha256: app.get(TextCaptureRunner).manifestSha256 });

  const log = jsonLogger(undefined, 'evaluation-worker');
  // The file worker's limits (audit W5): without them a database that stops answering would hold a claim or the stop below for ever.
  const pool = new Pool({ ...pgClientConfig(config.queueDatabaseUrl), ...WORKER_POOL_LIMITS, max: config.concurrency + 2, application_name: 'telesphoros-evaluation-worker' });
  pool.on('error', () => log('error', 'database-connection-error', { code: 'pool-error' }));
  const consumer = new EvaluationRequestConsumer(app.get(Database), app.get(EvaluationsService), config.profile);
  const runner = new Runner({
    workerId: config.workerId,
    queue: new JobQueue(pool),
    jobs: [evaluationRequestJob(consumer)],
    concurrency: config.concurrency,
    tenantCap: config.tenantCap,
    pollMs: config.pollMs,
    drainSeconds: config.drainSeconds,
    log,
  });
  runner.start();

  // A stop that left a job to lease expiry (a failed release, an outcome not recorded) exits 1 after closing the rest, so it is not read as a clean stop (audit W3).
  // The whole sequence is bounded by the drain plus a grace, as in the file worker: past it the process logs shutdown-forced and exits 1 (audit W5).
  const stop = boundedStop({
    steps: [
      { name: 'runner', run: () => runner.stop() },
      { name: 'pool', run: () => pool.end().catch(() => undefined) },
      { name: 'app', run: () => app.close() },
    ],
    log,
    exit: (code) => process.exit(code),
    deadlineMs: shutdownDeadlineMs(config.drainSeconds),
  });
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));
}

main().catch((error: unknown) => {
  // A start-up refusal names the setting that is wrong, never a value.
  process.stderr.write(`evaluation worker failed to start: ${error instanceof Error ? error.message : 'unknown error'}\n`);
  process.exit(1);
});
