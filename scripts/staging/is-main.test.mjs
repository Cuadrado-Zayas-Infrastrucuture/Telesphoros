// Tests for scripts/staging/is-main.mjs, the "run as a command" check of every staging gate script. Imported by
// infrastructure/terraform/guard.test.mjs, so `pnpm test:infra` runs it. Node resolves symlinks for import.meta.url but not for
// process.argv[1], so a plain comparison is false when the path crosses a symlink (macOS /tmp is one): the script then skipped its whole
// body and exited 0, and a gate such as release-check.mjs passed without checking anything.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const staging = new URL('./', import.meta.url).pathname;
const box = mkdtempSync(join(tmpdir(), 'is-main-'));
after(() => rmSync(box, { recursive: true, force: true }));
const linked = join(box, 'staging');
symlinkSync(staging, linked);

// Each refuses when run with no arguments.
const GATES = [
  'check-medication-fence-rollout.mjs',
  'check-plan.mjs',
  'staging-status.mjs',
  'verify-image.mjs',
  'release/fence-image-record.mjs',
  'release/fence-vars.mjs',
  'release/migration-pending.mjs',
  'release/plan-record.mjs',
  'release/release-check.mjs',
];
const exit = (path) => spawnSync(process.execPath, [path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).status;

test('every gate script refuses with no arguments, from its own path and through a symlinked folder', () => {
  for (const gate of GATES) {
    assert.notEqual(exit(join(staging, gate)), 0, `${gate} from its own path`);
    assert.notEqual(exit(join(linked, gate)), 0, `${gate} through a symlink`);
  }
});

test('imported by `node -e` with a first argument that is not a file (image.sh passes the break-glass reason), every gate script loads', () => {
  for (const gate of GATES) {
    const url = new URL(gate, `file://${staging}`).href;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(url)}); console.log('imported');`, 'not a file'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(r.status, 0, `${gate}: ${r.stderr}`);
    assert.equal(r.stdout.trim(), 'imported', gate);
  }
});

test('every gate script decides "run as a command" with isMain, not by comparing paths itself', () => {
  for (const gate of GATES) {
    const source = readFileSync(join(staging, gate), 'utf8');
    assert.match(source, /if \(isMain\(import\.meta\.url\)\)/, gate);
    assert.doesNotMatch(source, /process\.argv\[1\] *[=&)]/, gate);
  }
});
