// Real PostgreSQL regression. No forced Jest exit or modified test/hook timeout.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { test } = require('node:test');
const cwd = path.resolve(__dirname, '../../apps/backend');
const backendRequire = require('node:module').createRequire(path.join(cwd, 'package.json'));
const { Client } = backendRequire('pg');
if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required: use a disposable PostgreSQL cluster');
async function databases() {
  const client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  try {
    await client.connect();
    return (await client.query('SELECT datname FROM pg_database WHERE left(datname, 5)=$1 ORDER BY datname', ['test_'])).rows.map(row => row.datname);
  } finally { await client.end(); }
}
for (const [mode, file, name, expected] of [
  ['split', 'test/local-storage-intake.e2e-spec.ts', 'stores and retrieves exact lab-pdf', 0],
  ['late', 'test/local-storage-intake.e2e-spec.ts', 'stores and retrieves exact lab-pdf', 1],
  ['lock', 'test/db/report-registration.pg-spec.ts', 'fails migration on bounded lock contention', 0],
  ['late-lock', 'test/db/report-registration.pg-spec.ts', 'fails migration on bounded lock contention', 1],
]) {
  test(`${mode}: real resources close naturally and checks retain their deadlines`, async () => {
    const before = await databases();
    const result = spawnSync(process.execPath, [backendRequire.resolve('jest/bin/jest'), '--runInBand',
      '--runTestsByPath', file, '--testNamePattern', name,
      '--setupFilesAfterEnv', path.join(__dirname, 'fixture-delay.cjs')], {
      cwd, env: { ...process.env, TEST_STORAGE: 'postgres', TEST_OBJECT_STORAGE: 'memory', FIXTURE_REGRESSION_MODE: mode },
      encoding: 'utf8', timeout: 25000, maxBuffer: 2 * 1024 * 1024,
    });
    // Preserve the child's complete permitted evidence in the producer output, including expected failure.
    process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
    assert.ifError(result.error);
    assert.equal(result.signal, null, 'Jest must exit naturally; the outer bound cannot make a failing child pass');
    assert.equal(result.status, expected);
    const output = (result.stdout ?? '') + (result.stderr ?? '');
    assert.doesNotMatch(output, /Cannot read properties|environment has been torn down|Jest did not exit/);
    if (mode === 'late') assert.match(output, /Exceeded timeout of 5000 ms for a hook/);
    if (mode === 'late-lock') assert.match(output, /Exceeded timeout of 5000 ms for a test/);
    assert.deepEqual(await databases(), before, 'fixture databases must be reclaimed, including after a timed-out hook');
  });
}
