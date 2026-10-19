import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { problems } from './verify-workflow.mjs';
const text = readFileSync(new URL('../../.github/workflows/fixture-phase-capture.yml', import.meta.url), 'utf8');

test('the actual capture workflow keeps one new-branch job, the original watchdog and failure artifacts', () => {
  assert.deepEqual(problems(text), []);
  for (const mutate of [
    s => s.replace('    branches: [chore/native-x64-fixture-capture-20261018]', '    branches: [main]'),
    s => s.replace('on:\n  push:', 'on:\n  pull_request:'),
    s => s + '\n  another-job:\n    runs-on: ubuntu-24.04\n',
    s => s.replace("github.event.created == true && github.run_attempt == '1'", 'true'),
    s => s.replace('30 * 60_000', '60 * 60_000'),
    s => s.replace("always() && steps.evidence.outputs.bounded == 'true'", 'success()'),
    s => s.replace('run: node diagnostics/fixture-phase-capture/capture.mjs run', 'run: node diagnostics/fixture-phase-capture/capture.mjs run || true'),
    s => s.replace('contents: read', 'contents: write'),
  ]) assert.ok(problems(mutate(text)).length > 0);
});

test('the real preload registers once and preserves existing config/deadline/worker settings', t => {
  const dir = mkdtempSync(join(tmpdir(), 'fixture-capture-preload-'));
  // Disposable synthetic test output only; the source configuration is loaded, never edited.
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = fileURLToPath(new URL('../../apps/backend/jest.config.js', import.meta.url));
  const preload = fileURLToPath(new URL('./preload.cjs', import.meta.url));
  const script = `const assert=require('node:assert/strict');const file=${JSON.stringify(config)};const a=require(file),b=require(file);assert.equal(a,b);assert.equal(a.setupFilesAfterEnv.length,1);assert.equal(a.maxWorkers,1);assert.equal(a.testTimeout,undefined);assert.equal(a.testRegex,'(src|test)/.*\\\\.(spec|e2e-spec|pg-spec|s3-spec)\\\\.ts$');`;
  const child = spawnSync(process.execPath, ['--require', preload, '-e', script], {
    env: { ...process.env, FIXTURE_CAPTURE_DIR: dir, TEST_DATABASE_URL: 'synthetic-selection-only', TEST_S3_ENDPOINT: 'http://127.0.0.1:5555' }, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const rows = readFileSync(join(dir, 'preload.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 2); assert.ok(rows.every(row => row.observerCount === 1 && row.testTimeout === 5000 && row.maxWorkers === 1));
});
