import { readdirSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { PRODUCTION_JOBS, evaluationRequest } from '@telesphoros/jobs';

const root = resolve(__dirname, '../../..');
const runtimeFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? runtimeFiles(join(dir, entry.name)) : /\.(module|controller)\.ts$/.test(entry.name) ? [join(dir, entry.name)] : [],
  );

it('keeps H1 out of runtime API registration and the production consumer set', () => {
  const files = runtimeFiles(join(root, 'apps/backend/src'));
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) expect(readFileSync(file, 'utf8')).not.toMatch(/evaluation-requests|EvaluationRequestsService/);
  expect(PRODUCTION_JOBS.some((job) => job.type === evaluationRequest.type)).toBe(false);
  expect(readFileSync(join(root, 'apps/worker/src/main.ts'), 'utf8')).not.toMatch(/evaluationRequest|evaluations\.request/);
});

it('keeps the H3 consumer in its own switched-off entry point: not in the API process and not in any deployment', () => {
  expect(readFileSync(join(root, 'apps/backend/src/main.ts'), 'utf8')).not.toMatch(/evaluation-worker|EvaluationRequestConsumer/);
  expect(readFileSync(join(root, 'apps/backend/src/evaluation-worker.ts'), 'utf8')).toMatch(/loadEvaluationWorkerConfig\(env\)/);
  const deployment = ['infrastructure', '.github/workflows'].flatMap((dir) =>
    readdirSync(join(root, dir), { withFileTypes: true, recursive: true })
      .filter((entry) => entry.isFile() && !/node_modules|\.terraform/.test(entry.parentPath))
      .map((entry) => join(entry.parentPath, entry.name)),
  );
  expect(deployment.length).toBeGreaterThan(10);
  const naming = deployment.filter((file) => /evaluation-worker|EVALUATION_WORKER/.test(readFileSync(file, 'latin1')));
  expect(naming).toEqual([]);
});

it('keeps inference-provider configuration out of the strict queue payload', () => {
  const requestId = '11111111-1111-4111-8111-111111111111';
  expect(evaluationRequest.payload.parse({ requestId })).toEqual({ requestId });
  for (const extra of [{ provider: 'bedrock' }, { model: 'synthetic-local-model' }, { text: 'synthetic document' }]) {
    expect(evaluationRequest.payload.safeParse({ requestId, ...extra }).success).toBe(false);
  }
});
