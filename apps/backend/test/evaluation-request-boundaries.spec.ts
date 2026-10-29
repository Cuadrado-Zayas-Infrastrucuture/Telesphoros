import { readdirSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { PRODUCTION_JOBS, evaluationRequest } from '@telesphoros/jobs';

const root = resolve(__dirname, '../../..');
const runtimeFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? runtimeFiles(join(dir, entry.name)) : /\.(module|controller)\.ts$/.test(entry.name) ? [join(dir, entry.name)] : [],
  );

// H4 (spec 007, founder decision D1): admission and status are reachable through one controller, registered by the lab-reports module and answered
// only while EVALUATION_REQUESTS is enabled (refused in production; test/evaluation-requests-api.e2e-spec.ts proves the service is absent while it is
// off). No other module or controller names them, and none names the H3 consumer or its entry point.
it('keeps admission behind its one controller, and the consumer out of every module and controller and of the production consumer set', () => {
  const files = runtimeFiles(join(root, 'apps/backend/src'));
  expect(files.length).toBeGreaterThan(10);
  const naming = files.filter((file) => /evaluation-requests|EvaluationRequestsService/.test(readFileSync(file, 'utf8'))).map((file) => file.slice(root.length + 1));
  expect(naming.sort()).toEqual(['apps/backend/src/lab-reports/evaluation-requests.controller.ts', 'apps/backend/src/lab-reports/lab-reports.module.ts']);
  for (const file of files) expect(readFileSync(file, 'utf8')).not.toMatch(/EvaluationRequestConsumer|evaluation-request-consumer|evaluation-worker/);
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

// Spec 012 slice 3 (T030): running outside a request under issued capabilities is the evaluation worker's alone. Any other caller of runWithCapability,
// or any other reader of the capability source than the database door, fails here and has to be argued for in review. Calls and the definition are
// matched, not mentions in comments.
it('lets only the evaluation-request consumer run under issued capabilities, and only the database read the source', () => {
  const sources = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? sources(join(dir, entry.name)) : /\.ts$/.test(entry.name) && !/\.spec\.ts$/.test(entry.name) ? [join(dir, entry.name)] : [],
    );
  const files = sources(join(root, 'apps/backend/src'));
  expect(files.length).toBeGreaterThan(50);
  const naming = (pattern: RegExp) =>
    files
      .filter((file) => pattern.test(readFileSync(file, 'utf8')))
      .map((file) => file.slice(root.length + 1))
      .sort();
  expect(naming(/\brunWithCapability\s*[<(]/)).toEqual(['apps/backend/src/auth/authority-context.ts', 'apps/backend/src/lab-reports/evaluation-request-consumer.ts']);
  expect(naming(/\bcurrentCapabilitySource\s*\(/)).toEqual(['apps/backend/src/auth/authority-context.ts', 'apps/backend/src/db/database.ts']);
});
