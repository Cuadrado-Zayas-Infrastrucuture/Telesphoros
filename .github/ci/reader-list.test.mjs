import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Spec 004 (FR-004): CI re-measures the list of specs that need the private report-reader engine, so it cannot go stale again.
const workflow = readFileSync(new URL('../workflows/ci.yml', import.meta.url), 'utf8');
const job = (name) => {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  assert.ok(start > 0, `job ${name} is in ci.yml`);
  const next = workflow.slice(start + 1).search(/\n  [a-z0-9-]+:\n/);
  return workflow.slice(start, next < 0 ? undefined : start + 1 + next);
};
const STEP = '- name: The reader-engine skip list still matches a run without the engine';
const COMMAND = 'TEST_STORAGE=postgres scripts/check-without-reader.sh --measure --listed';

test('the PostgreSQL job re-measures the reader-engine list after its tier, inside the shared budget', () => {
  const postgres = job('service-postgres');
  const step = postgres.indexOf(STEP);
  assert.ok(step > 0, 'the step is in service-postgres');
  assert.ok(step > postgres.indexOf('- name: "Tier 2: the whole API suite on PostgreSQL"'), 'it runs after the tier');
  const body = postgres.slice(step, postgres.indexOf('\n      - ', step + 1));
  assert.match(body, /node \.github\/ci\/service-budget\.mjs run <<'BUDGET'\n\s+TEST_STORAGE=postgres scripts\/check-without-reader\.sh --measure --listed\n\s+BUDGET/);
  assert.equal(workflow.split(COMMAND).length - 1, 1, 'it runs once, in one job');
});

test('the script refuses option combinations that would measure something else', () => {
  for (const args of [['--listed'], ['--measure', '--listed', '--write'], ['--write'], ['--unknown']]) {
    const run = spawnSync('bash', ['scripts/check-without-reader.sh', ...args], { encoding: 'utf8' });
    assert.equal(run.status, 2, `${args.join(' ')} is a usage error`);
  }
});
