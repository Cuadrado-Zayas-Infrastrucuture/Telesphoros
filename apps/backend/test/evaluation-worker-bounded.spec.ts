import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Audit W5: the evaluation worker's queue pool had no client-side limits, and its stop had no deadline. The limits and the bounded stop are shared with the
 * file worker (@telesphoros/jobs) and tested there and in apps/worker; only a source pin proves this entry point uses them, as for the file worker
 * (apps/worker/src/boundaries.test.ts).
 */
const main = readFileSync(join(__dirname, '../src/evaluation-worker.ts'), 'utf8');

it('builds its queue pool with WORKER_POOL_LIMITS', () => {
  expect(main).toMatch(/new Pool\(\{[^}]*\.\.\.WORKER_POOL_LIMITS/);
});

it('stops through boundedStop with a deadline taken from the drain, and does not call process.exit(0) itself', () => {
  expect(main).toMatch(/boundedStop\(\{[\s\S]*deadlineMs:\s*shutdownDeadlineMs\(config\.drainSeconds\)/);
  expect(main).not.toMatch(/process\.exit\(0\)/);
  expect(main).not.toMatch(/failed \? 1 : 0/);
});

it('still stops the runner, the queue pool and the application, in that order', () => {
  const at = (name: string) => main.search(new RegExp(`name: '${name}'`));
  expect(at('runner')).toBeGreaterThan(-1);
  expect(at('runner')).toBeLessThan(at('pool'));
  expect(at('pool')).toBeLessThan(at('app'));
});
