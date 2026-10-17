const { spawnSync } = require('node:child_process');
const { appendFileSync, existsSync, statSync, writeFileSync } = require('node:fs');
const { isAbsolute, join } = require('node:path');
const { performance } = require('node:perf_hooks');
const { run, libraries, prepared } = require('./workspace.cjs');

// This is a fresh job producer, not a compiled-output cache. Consumer builds/tests still run.
function prepareServiceTests(env = process.env, execute = spawnSync) {
  try {
    const envFile = env.GITHUB_ENV;
    const directory = env.RUNNER_TEMP;
    if (!envFile || !directory || !isAbsolute(envFile) || !isAbsolute(directory)
      || !statSync(directory).isDirectory()
      || (existsSync(envFile) && !statSync(envFile).isFile())) throw new Error('Invalid job context');

    // An inherited marker or a previous receipt never substitutes for this producer.
    const cleanEnv = { ...env };
    delete cleanEnv[prepared];
    const started = performance.now();
    const exitCode = run(['prepare', ...libraries], cleanEnv, execute);
    // Whitelist only the build phase's timing, native result, runtime, and fixed library names.
    const receipt = {
      format: 1,
      phase: 'shared-library-build',
      libraries: [...libraries],
      durationMs: Math.round(performance.now() - started),
      exitCode,
      nodeVersion: process.versions.node,
    };
    writeFileSync(join(directory, 'service-test-prerequisites.json'), JSON.stringify(receipt) + '\n', { mode: 0o600 });
    if (exitCode !== 0) return exitCode;
    // GitHub makes this available to later steps only after the producer exits successfully.
    appendFileSync(envFile, prepared + '=1\n');
    process.stdout.write(JSON.stringify(receipt) + '\n');
    return 0;
  } catch {
    // Filesystem errors can contain paths or environment values; do not serialize them.
    process.stderr.write('Service-test prerequisite preparation failed.\n');
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = process.argv.length === 2 ? prepareServiceTests() : 1;
}
module.exports = { prepareServiceTests };
