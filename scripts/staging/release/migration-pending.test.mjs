// Tests for scripts/staging/release/migration-pending.mjs (spec 027, PR 3b). Imported by infrastructure/terraform/guard.test.mjs (`pnpm test:infra`).
// What this cannot prove: that the real `migrate status` keeps printing its pending line this way (the last release's line was "pending: 0071").
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { expectedPending, parsePending, pendingProblem } from './migration-pending.mjs';

const FILES = ['0069_a.up.sql', '0069_a.down.sql', '0070_b.up.sql', '0070_b.down.sql', '0071_c.up.sql', '0071_c.down.sql', 'README.md'];

test('expected: the up migrations after newestMigration, in order; a newest that is not at this commit is refused', () => {
  assert.deepEqual(expectedPending(FILES, '0069'), ['0070', '0071']);
  assert.deepEqual(expectedPending(FILES, '0071'), []);
  assert.throws(() => expectedPending(FILES, '0072'), /not a migration at this commit/);
  assert.throws(() => expectedPending(FILES, '71'), /four-digit/);
  assert.throws(() => expectedPending(FILES, undefined), /four-digit/);
});

test('parse: the last pending line, tab-separated or not; anything unreadable is refused', () => {
  assert.deepEqual(parsePending('migrations dir: /app/migrations\tapplied: 0001, 0002\tpending: 0070, 0071\n'), ['0070', '0071']);
  assert.deepEqual(parsePending('pending: 0071\nlater\npending: (none)\n'), []);
  assert.throws(() => parsePending('applied: 0001\n'), /no "pending:" line/);
  assert.throws(() => parsePending('pending: 0071_c\n'), /unreadable/);
});

test('judge: a first run needs exactly the expected list; a resumed run also accepts its tail, never anything else', () => {
  assert.equal(pendingProblem(['0070', '0071'], ['0070', '0071'], false), null);
  assert.equal(pendingProblem([], [], false), null);
  assert.match(pendingProblem(['0070', '0071'], ['0071'], false), /not exactly 0070 0071/, 'a stale facts file is not taken for an interrupted run');
  assert.match(pendingProblem(['0071'], ['0070', '0071'], false), /not exactly 0071/, 'more pending than this release carries');
  assert.match(pendingProblem(['0071'], [], false), /pending is \(none\), not exactly 0071/);
  assert.equal(pendingProblem(['0070', '0071'], ['0071'], true), null);
  assert.equal(pendingProblem(['0070', '0071'], [], true), null);
  assert.match(pendingProblem(['0070', '0071'], ['0070'], true), /neither 0070 0071 nor a tail/);
  assert.match(pendingProblem(['0070'], ['0070', '0071'], true), /neither/);
});

const box = mkdtempSync(join(tmpdir(), 'migration-pending-'));
after(() => rmSync(box, { recursive: true, force: true }));
const cli = (...args) => spawnSync(process.execPath, [new URL('./migration-pending.mjs', import.meta.url).pathname, ...args], { encoding: 'utf8' });

test('the command line: expected prints the list, check exits 1 on a problem and 2 on unreadable input', () => {
  const dir = join(box, 'migrations');
  mkdirSync(dir);
  for (const f of FILES) writeFileSync(join(dir, f), '');
  writeFileSync(join(box, 'facts.json'), JSON.stringify({ newestMigration: '0069' }));
  const expected = cli('expected', dir, join(box, 'facts.json'));
  assert.equal(expected.status, 0, expected.stderr);
  assert.equal(expected.stdout.trim(), '0070 0071');
  writeFileSync(join(box, 'status.txt'), 'pending: 0070, 0071\n');
  assert.equal(cli('check', '0070 0071', join(box, 'status.txt')).status, 0);
  const wrong = cli('check', '0071', join(box, 'status.txt'));
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /not exactly 0071/);
  writeFileSync(join(box, 'status.txt'), 'migrate status failed\n');
  assert.equal(cli('check', '0071', join(box, 'status.txt')).status, 2);
});
