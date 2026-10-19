import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { cpus, totalmem } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { loadBudget, runScript } from '../../.github/ci/service-budget.mjs';
import { runProducer } from '../../.github/ci/service-evidence.mjs';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const baseline = '37d1e96c7e38c9eb9bd004b01e609df4b62dd36a';
export const protectedPaths = ['apps/backend', '.github/ci', '.github/workflows/ci.yml', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'scripts/workspace-build'];
export const profileScript = 'set -o pipefail\npnpm --filter @telesphoros/backend test 2>&1 | tee tier1.log\n! grep -F "[jest] NOT RUNNING" tier1.log\n';
const expected = JSON.parse(readFileSync(new URL('./expected-files.json', import.meta.url)));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const read = file => JSON.parse(readFileSync(file, 'utf8'));
const write = (directory, name, value) => writeFileSync(join(directory, name), JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 });
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const strip = text => text.replace(/\x1b\[[0-9;]*m/g, '');

export function sourceSnapshot() {
  assert.equal(git('rev-parse', baseline + '^{commit}'), baseline);
  git('diff', '--quiet', baseline, '--', ...protectedPaths);
  const names = execFileSync('git', ['ls-files', '-z', '--', ...protectedPaths], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean).sort();
  return { checkout: git('rev-parse', 'HEAD'), baseline, files: Object.fromEntries(names.map(name => [name, hash(readFileSync(join(root, name)))])) };
}

export function verifySelection(original, observed, cwd = root) {
  const normalize = list => list.map(file => relative(join(cwd, 'apps/backend'), file).replaceAll('\\', '/'));
  assert.deepEqual(observed, original, 'Observer changed selected files/order.');
  assert.deepEqual(normalize(original), expected.selected, 'Selection differs from the full original workload.');
  return { identicalOrder: true, selectedFiles: original.length, expectedActiveFiles: expected.active.length };
}

export function parseTests(log) {
  const text = strip(log);
  const seen = new Map();
  for (const [, state, file] of text.matchAll(/^(PASS|FAIL) ((?:test|src)\/\S+\.(?:spec|e2e-spec|pg-spec|s3-spec)\.ts)(?:[^\n]*)$/gm)) {
    if (seen.has(file)) assert.equal(seen.get(file), state, 'Contradictory reported suite result.');
    seen.set(file, state);
  }
  const files = [...seen.entries()];
  const summaries = text.split('\n').filter(line => /^(Test Suites:|Tests:|Time:)/.test(line));
  const counts = {};
  for (const [name, prefix] of [['tests', 'Tests:'], ['suites', 'Test Suites:']]) {
    const lines = summaries.filter(line => line.startsWith(prefix));
    if (lines.length === 1) counts[name] = Object.fromEntries(['passed', 'failed', 'skipped', 'total'].map(state => [state, Number(lines[0].match(new RegExp('(\\d+) ' + state))?.[1] ?? 0)]));
  }
  return { files, summaries, counts, complete: JSON.stringify(files.map(([file]) => file)) === JSON.stringify(expected.active)
    && counts.tests?.total === 2485 && counts.tests.skipped === 253 && counts.suites?.total === 170
    && counts.tests.passed + counts.tests.failed + counts.tests.skipped === counts.tests.total
    && counts.suites.passed + counts.suites.failed + counts.suites.skipped === counts.suites.total
    && counts.suites.passed === files.filter(([, state]) => state === 'PASS').length
    && counts.suites.failed === files.filter(([, state]) => state === 'FAIL').length };
}

export async function supervise(produce, child, ready, shutdownMs = 5000) {
  let finished = false, premature = false;
  const exited = new Promise(done => {
    child.once('error', () => { premature = !finished; done({ code: 1, signal: null, spawnError: true }); });
    child.once('exit', (code, signal) => { premature = !finished; done({ code, signal }); });
  });
  let native, failure;
  try { await ready(); native = await produce(); }
  catch (error) { failure = error; }
  finally {
    finished = true;
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }
  let timer;
  const expired = new Promise(done => { timer = setTimeout(() => done(null), shutdownMs); });
  let monitor;
  try {
    monitor = await Promise.race([exited, expired]);
    if (!monitor) { child.kill('SIGKILL'); monitor = await exited; }
  } finally { clearTimeout(timer); }
  if (failure) throw failure;
  return { native, monitor, premature };
}

function rows(directory, name) {
  const file = join(directory, name);
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
}

export function verifyCapture(directory, log, native) {
  assert.equal(isAbsolute(directory), true);
  assert.ok(!existsSync(join(directory, 'capture-errors.jsonl')), 'Recording failed or reached its limit.');
  assert.ok(!existsSync(join(directory, 'controller-error.json')), 'Controller did not complete.');
  const tests = parseTests(log), setup = rows(directory, 'setup.jsonl'), pg = rows(directory, 'pg-watch.jsonl'), config = rows(directory, 'preload.jsonl');
  const opens = setup.filter(row => row.event === 'suite-open');
  assert.ok(tests.complete, 'Full workload did not finish in the original order.');
  assert.equal(native === 0, tests.counts.tests.failed === 0 && tests.counts.suites.failed === 0, 'Native status contradicts Jest summary.');
  assert.equal(new Set(opens.map(row => row.file)).size, opens.length, 'Observer was installed twice in a suite.');
  for (const file of expected.active) assert.ok(opens.some(row => row.file === file), 'Missing observed suite.');
  assert.ok(config.length && config.every(row => row.event === 'config' && row.testTimeout === 5000 && row.maxWorkers === 1 && row.observerCount === 1), 'Jest configuration changed.');
  assert.ok(pg.some(row => row.event === 'connected') && pg.some(row => row.event === 'sample') && pg.some(row => row.event === 'stopped'), 'Incomplete independent monitor.');
  assert.ok(!pg.some(row => row.event === 'error'), 'Independent monitor failed.');
  const actor = setup.filter(row => row.file === 'test/db/system-actor.pg-spec.ts');
  assert.ok(actor.some(row => row.event === 'fixture-start'), 'Actor fixture was not reached.');
  assert.ok(actor.some(row => row.event === 'operation-start'), 'Actor phase starts missing.');
  if (tests.files.find(([file]) => file === 'test/db/system-actor.pg-spec.ts')?.[1] === 'PASS') {
    assert.ok(actor.some(row => row.event === 'fixture-end' && row.ok), 'Passing actor fixture lacks its completion.');
  }
  return { captureComplete: true, productPassed: native === 0, tests, completedFixtures: setup.filter(row => row.event === 'fixture-end').length,
    actor: actor.filter(row => ['fixture-start', 'fixture-end', 'fixture-four-seconds'].includes(row.event)), nativeProducer: native };
}

async function toolchain(directory) {
  const command = (name, args) => execFileSync(name, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'x64'); assert.equal(process.versions.node, '22.22.0');
  assert.equal(process.env.RUNNER_ARCH, 'X64'); assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
  const database = new URL(process.env.TEST_DATABASE_URL), s3 = new URL(process.env.TEST_S3_ENDPOINT);
  assert.equal(database.hostname, '127.0.0.1'); assert.equal(database.port, '5432'); assert.equal(database.pathname, '/postgres');
  assert.equal(s3.origin, 'http://127.0.0.1:5555');
  const req = createRequire(join(root, 'apps/backend/package.json'));
  const swc = req('@swc/core'); assert.ok(swc.transformSync('const x: number=1', { jsc: { parser: { syntax: 'typescript' } } }).code.includes('x'));
  const { Client } = req('pg'), client = new Client({ connectionString: database.toString() });
  let server;
  try {
    await client.connect();
    server = (await client.query("SELECT version() AS version,current_setting('fsync') AS fsync,current_setting('synchronous_commit') AS synchronous_commit,current_setting('full_page_writes') AS full_page_writes")).rows[0];
  } finally { await client.end(); }
  const versions = { pgDump: command('pg_dump', ['--version']), pgRestore: command('pg_restore', ['--version']), python: command('python', ['--version']),
    moto: command('python', ['-c', "import importlib.metadata; print(importlib.metadata.version('moto'))"]) };
  database.password = 'wrong-synthetic-password';
  const wrong = new Client({ connectionString: database.toString() });
  let authCode;
  try { await wrong.connect(); } catch (error) { authCode = error.code; } finally { await wrong.end(); }
  assert.equal(authCode, '28P01');
  write(directory, 'toolchain.json', { node: process.versions.node, platform: process.platform, architecture: process.arch, cpus: cpus().length, memoryBytes: totalmem(),
    runnerImage: process.env.ImageVersion ?? null, versions, server, wrongPasswordRefused: true });
  assert.match(server.version, /^PostgreSQL 16\.15\b.*x86_64/); assert.equal(server.fsync, 'on'); assert.equal(server.synchronous_commit, 'on'); assert.equal(server.full_page_writes, 'on');
  assert.match(versions.pgDump, /PostgreSQL\) 16\.15\b/); assert.match(versions.pgRestore, /PostgreSQL\) 16\.15\b/);
  assert.match(versions.python, /^Python 3\.12\./); assert.equal(versions.moto, '5.2.4');
}

async function run() {
  const directory = process.env.FIXTURE_CAPTURE_DIR;
  assert.equal(directory, join(process.env.RUNNER_TEMP, 'fixture-phase-capture'));
  assert.equal(isAbsolute(directory), true);
  mkdirSync(directory, { mode: 0o700 });
  let stage = 'identity';
  try {
    const budget = loadBudget();
    assert.equal(process.env.NODE_OPTIONS ?? '', '', 'Unexpected existing Node preload.');
    const source = sourceSnapshot(); assert.equal(source.checkout, budget.checkout);
    write(directory, 'identity.json', { diagnosticOnly: true, budget, source });
    stage = 'toolchain'; await toolchain(directory);
    stage = 'selection';
    const select = cache => `pnpm --filter @telesphoros/backend exec jest --listTests --json --cacheDirectory="$RUNNER_TEMP/fixture-selection-${cache}" > "$FIXTURE_CAPTURE_DIR/selection-${cache}.json"`;
    assert.equal(await runScript(select('baseline'), budget), 0);
    const env = { ...process.env, NODE_OPTIONS: '--require=' + JSON.stringify(join(root, 'diagnostics/fixture-phase-capture/preload.cjs')) };
    assert.equal(await runScript(select('observed'), budget, { env }), 0);
    write(directory, 'selection.json', verifySelection(read(join(directory, 'selection-baseline.json')), read(join(directory, 'selection-observed.json'))));
    stage = 'memory-profile';
    const child = spawn(process.execPath, [join(root, 'diagnostics/fixture-phase-capture/pg-watch.cjs')], { env: process.env, stdio: ['ignore', 'inherit', 'inherit'] });
    const result = await supervise(async () => {
      // runProducer reads process.env. Only the unchanged full test producer receives the preload.
      process.env.NODE_OPTIONS = env.NODE_OPTIONS;
      try { return await runProducer('memory', profileScript); }
      finally { delete process.env.NODE_OPTIONS; }
    }, child, async () => {
      const end = Date.now() + 5000;
      while (!existsSync(join(directory, 'pg-watch-ready'))) {
        assert.ok(child.exitCode === null && child.signalCode === null && Date.now() < end, 'Independent monitor did not become ready.');
        await delay(50);
      }
    });
    write(directory, 'producer.json', result);
    assert.equal(result.premature, false, 'Independent monitor exited during the profile.');
    assert.equal(result.monitor.code, 0); assert.equal(result.monitor.signal, null);
    // Preserve the producer's native failure. Capture validity is checked independently afterward.
    process.exitCode = result.native;
  } catch {
    write(directory, 'controller-error.json', { stage });
    process.stderr.write('Fixture capture controller failed at ' + stage + '.\n'); process.exitCode = 1;
  }
}

function finalize() {
  const directory = process.env.FIXTURE_CAPTURE_DIR;
  assert.equal(directory, join(process.env.RUNNER_TEMP, 'fixture-phase-capture'));
  // Bound the artifact even if semantic verification fails on partial/cancelled evidence.
  // Ordinary test failures and incomplete traces must still be downloadable when bounded.
  const before = readdirSync(directory).reduce((size, name) => {
    const file = join(directory, name); assert.ok(lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink()); return size + lstatSync(file).size;
  }, 0);
  assert.ok(before < 10 * 1024 * 1024 - 65536, 'Diagnostic artifact exceeds the reserved size limit.');
  assert.ok(process.env.GITHUB_OUTPUT && isAbsolute(process.env.GITHUB_OUTPUT));
  appendFileSync(process.env.GITHUB_OUTPUT, 'bounded=true\n');
  const identity = read(join(directory, 'identity.json')), producer = read(join(directory, 'producer.json'));
  assert.deepEqual(loadBudget(), identity.budget, 'Capture budget/attempt differs from the live watchdog.');
  assert.ok(existsSync(join(directory, 'toolchain.json')), 'Toolchain proof is absent.');
  assert.deepEqual(sourceSnapshot(), identity.source, 'Source changed during capture.');
  assert.equal(producer.premature, false); assert.equal(producer.monitor.code, 0); assert.equal(producer.monitor.signal, null);
  const summary = verifyCapture(directory, readFileSync(join(root, 'tier1.log'), 'utf8'), producer.native);
  for (const name of ['service-budget.json', 'service-watchdog.json']) {
    const file = join(process.env.RUNNER_TEMP, name);
    if (existsSync(file)) write(directory, name, read(file));
  }
  const watchdog = read(join(directory, 'service-watchdog.json'));
  assert.equal(watchdog.sourceHash, hash(readFileSync(join(root, '.github/ci/service-deadline.mjs'))));
  assert.equal(watchdog.state, 'armed');
  const total = readdirSync(directory).reduce((size, name) => { const file = join(directory, name); assert.ok(lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink()); return size + lstatSync(file).size; }, 0);
  assert.ok(total + Buffer.byteLength(JSON.stringify(summary)) < 10 * 1024 * 1024, 'Diagnostic artifact exceeds 10MiB.');
  write(directory, 'summary.json', summary);
  console.log(JSON.stringify({ captureComplete: summary.captureComplete, productPassed: summary.productPassed, nativeProducer: producer.native, artifactBytes: total }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error('Expected capture command.');
    if (process.argv[2] === 'run') await run();
    else if (process.argv[2] === 'finalize') finalize();
    else throw new Error('Unknown capture command.');
  } catch { process.stderr.write('Fixture capture command failed.\n'); process.exitCode = 1; }
}
