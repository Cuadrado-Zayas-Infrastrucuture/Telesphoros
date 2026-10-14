import { appendFile, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { defineJob, fatal, retryable } from '@telesphoros/jobs';
import type { RegisteredJob } from '../runner';

/**
 * Jobs that exist only to prove the queue (M2.3a). They touch no clinical record and no database table: their one effect is a marker file under
 * WORKER_TEST_EFFECT_DIR, created with an exclusive flag so "this ran to completion" can be counted exactly. A production worker refuses to register them
 * (config.ts), and the API has no definition of them to enqueue.
 */
const base = { maxAttempts: 3, leaseSeconds: 5, timeoutSeconds: 30, testOnly: true } as const;

export const testEcho = defineJob({ ...base, type: 'test.echo', payload: z.strictObject({ n: z.number().int() }) });
export const testSlow = defineJob({ ...base, type: 'test.slow', payload: z.strictObject({ ms: z.number().int().min(0).max(120_000) }) });
export const testFail = defineJob({ ...base, type: 'test.fail', payload: z.strictObject({ code: z.string().min(2).max(48), canRetry: z.boolean() }) });
export const testHang = defineJob({ ...base, timeoutSeconds: 1, type: 'test.hang', payload: z.strictObject({}) });
export const testThrow = defineJob({ ...base, type: 'test.throw', payload: z.strictObject({}) });

async function mark(dir: string, name: string): Promise<boolean> {
  await mkdir(dir, { recursive: true });
  try {
    await (await open(join(dir, name), 'wx')).close();
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(timer), reject(new Error('aborted'))), { once: true });
  });

export function testJobs(effectDir: string): RegisteredJob[] {
  // Every run leaves `<job>.run-<attempt>.<worker pid>`; a completed run leaves `<job>.done` exactly once however many times it runs.
  const run = async (jobId: string, attempt: number) => mark(effectDir, `${jobId}.run-${attempt}.${process.pid}`);
  return [
    { definition: testEcho, handler: async ({ job }) => void (await run(job.id, job.attempt), await mark(effectDir, `${job.id}.done`)) },
    {
      definition: testSlow,
      handler: async ({ job, signal }) => {
        await run(job.id, job.attempt);
        await appendFile(join(effectDir, `${job.id}.started`), `${process.pid}\n`);
        await sleep(Number(job.payload.ms), signal);
        await mark(effectDir, `${job.id}.done`);
      },
    },
    {
      definition: testFail,
      handler: async ({ job }) => {
        await run(job.id, job.attempt);
        throw (job.payload.canRetry ? retryable : fatal)(String(job.payload.code));
      },
    },
    { definition: testHang, handler: async ({ job }) => (await run(job.id, job.attempt), new Promise<void>(() => undefined)) },
    {
      definition: testThrow,
      handler: async ({ job }) => {
        await run(job.id, job.attempt);
        throw new Error('this message names patient Jane Doe and must never reach a log or the database');
      },
    },
  ];
}
