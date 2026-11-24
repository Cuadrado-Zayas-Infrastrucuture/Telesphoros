const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runAgainstDemo, exitCodeOf, teardownModeFrom } = require('./product-demo-ci.cjs');

// Stand-in launchers: each prints what start.cjs prints and records the signal it got, so the tests see the real stop handshake.
const READY = 'Synthetic storage ready: http://127.0.0.1:4173; run 3f1c2a9e-0b7d-4e55-9a51-2d6c8e4f7a10';
function fake(dir, name, body) {
  const file = path.join(dir, name + '.cjs');
  fs.writeFileSync(file, `const fs = require('node:fs'); const mark = process.argv[2];\n${body}\n`);
  return file;
}
const stoppable = `console.log(${JSON.stringify(READY)}); process.on('SIGINT', () => { fs.writeFileSync(mark, 'stopped'); process.exit(0); }); setInterval(() => {}, 1000);`;
const quiet = { write() {} };
// Each test fails rather than hangs the verify job if the wrapper stops returning.
const LIMIT = 20_000;
async function gone(pid) {
  for (let i = 0; i < 40; i++) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return true; throw error; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return false;
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'product-demo-ci-'));
  const mark = path.join(dir, 'demo-stopped');
  const ran = path.join(dir, 'command-ran');
  const launcher = file => [process.execPath, file, mark];
  const command = code => [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(ran)}, 'ran'); process.exit(${code})`];
  return { dir, mark, ran, launcher, command };
}

test('a passing command against a ready demo passes, and the demo is stopped through its own teardown', { timeout: LIMIT }, async () => {
  const s = setup();
  const result = await runAgainstDemo(s.command(0), { launcher: s.launcher(fake(s.dir, 'demo', stoppable)), log: quiet });
  assert.deepEqual({ status: result.status, problem: result.problem }, { status: 0, problem: null });
  assert.equal(result.run, '3f1c2a9e-0b7d-4e55-9a51-2d6c8e4f7a10');
  assert.ok(fs.existsSync(s.ran));
  assert.equal(fs.readFileSync(s.mark, 'utf8'), 'stopped');
  assert.equal(exitCodeOf(result), 0);
});

test('a failing command fails the run, and the demo is still stopped', { timeout: LIMIT }, async () => {
  const s = setup();
  const result = await runAgainstDemo(s.command(3), { launcher: s.launcher(fake(s.dir, 'demo', stoppable)), log: quiet });
  assert.equal(result.status, 3);
  assert.equal(result.problem, null);
  assert.equal(fs.readFileSync(s.mark, 'utf8'), 'stopped');
  assert.equal(exitCodeOf(result), 3);
});

test('a demo that never reports ready fails the run, runs no command, and is stopped', { timeout: LIMIT }, async () => {
  const s = setup();
  const silent = `process.on('SIGINT', () => { fs.writeFileSync(mark, 'stopped'); process.exit(0); }); setInterval(() => {}, 1000);`;
  const result = await runAgainstDemo(s.command(0), { launcher: s.launcher(fake(s.dir, 'demo', silent)), readyMs: 300, log: quiet });
  assert.match(result.problem.message, /not ready/);
  assert.ok(!fs.existsSync(s.ran));
  assert.equal(fs.readFileSync(s.mark, 'utf8'), 'stopped');
  assert.notEqual(exitCodeOf(result), 0);
});

test('a demo that exits before it is ready fails the run and runs no command', { timeout: LIMIT }, async () => {
  const s = setup();
  const result = await runAgainstDemo(s.command(0), { launcher: s.launcher(fake(s.dir, 'demo', 'process.exit(1);')), log: quiet });
  assert.match(result.problem.message, /exited before it was ready/);
  assert.ok(!fs.existsSync(s.ran));
  assert.notEqual(exitCodeOf(result), 0);
});

test('a teardown that fails fails a run whose command passed', { timeout: LIMIT }, async () => {
  const s = setup();
  const failing = `console.log(${JSON.stringify(READY)}); process.on('SIGINT', () => process.exit(1)); setInterval(() => {}, 1000);`;
  const result = await runAgainstDemo(s.command(0), { launcher: s.launcher(fake(s.dir, 'demo', failing)), log: quiet });
  assert.equal(result.status, 0);
  assert.match(result.problem.message, /teardown failed/);
  assert.notEqual(exitCodeOf(result), 0);
});

test('a demo that does not stop in time is killed and fails the run', { timeout: LIMIT }, async () => {
  const s = setup();
  const stubborn = `fs.writeFileSync(mark, String(process.pid)); console.log(${JSON.stringify(READY)}); process.on('SIGINT', () => {}); setInterval(() => {}, 1000);`;
  const result = await runAgainstDemo(s.command(0), { launcher: s.launcher(fake(s.dir, 'demo', stubborn)), stopMs: 300, log: quiet });
  assert.match(result.problem.message, /did not stop/);
  assert.notEqual(exitCodeOf(result), 0);
  // Killed, not merely abandoned: a demo left running would hold the job's fixed ports.
  const pid = Number(fs.readFileSync(s.mark, 'utf8'));
  assert.ok(await gone(pid), `demo process ${pid} is still running`);
});

test('a command is required', { timeout: LIMIT }, async () => {
  await assert.rejects(() => runAgainstDemo([], { log: quiet }), /Name the command/);
});

test('the exit code keeps a failed command and never reports success over a problem', { timeout: LIMIT }, () => {
  assert.equal(exitCodeOf({ status: 0, problem: null }), 0);
  assert.equal(exitCodeOf({ status: 7, problem: null }), 7);
  assert.equal(exitCodeOf({ status: 7, problem: new Error('x') }), 7);
  assert.equal(exitCodeOf({ status: 0, problem: new Error('x') }), 1);
  assert.equal(exitCodeOf({ status: null, problem: null }), 1);
});

// Warn mode (PRODUCT_DEMO_TEARDOWN_FAILURE=warn, the browser job while the CI teardown failure is diagnosed): only a teardown that exits non-zero becomes
// a warning carrying the launcher's reason. Every other failure still fails the run.
const failingTeardown = `console.log(${JSON.stringify(READY)}); process.on('SIGINT', () => { console.error('Local storage operation failed; inspect private run/control state.'); console.error('Reason: ' + (process.env.LOCAL_STORAGE_SHOW_REASON === '1' ? 'Occupied local port; no service was contacted or stopped.' : 'not asked')); process.exit(1); }); setInterval(() => {}, 1000);`;

test('warn mode: a failed teardown after a passing command passes, with a warning that carries the launcher reason', { timeout: LIMIT }, async () => {
  const s = setup();
  const result = await runAgainstDemo(s.command(0), { launcher: s.launcher(fake(s.dir, 'demo', failingTeardown)), teardownFailure: 'warn', log: quiet });
  assert.equal(result.status, 0);
  assert.equal(result.problem, null);
  assert.match(result.warning, /teardown failed/);
  assert.match(result.warning, /Occupied local port; no service was contacted or stopped\./);
  assert.equal(exitCodeOf(result), 0);
});

test('fail mode (the default): a failed teardown fails the run and names the launcher reason', { timeout: LIMIT }, async () => {
  const s = setup();
  const result = await runAgainstDemo(s.command(0), { launcher: s.launcher(fake(s.dir, 'demo', failingTeardown)), log: quiet });
  assert.match(result.problem.message, /teardown failed.*Occupied local port/);
  assert.equal(result.warning, null);
  assert.notEqual(exitCodeOf(result), 0);
});

test('warn mode never hides a failing command', { timeout: LIMIT }, async () => {
  const s = setup();
  const result = await runAgainstDemo(s.command(3), { launcher: s.launcher(fake(s.dir, 'demo', failingTeardown)), teardownFailure: 'warn', log: quiet });
  assert.equal(exitCodeOf(result), 3);
});

test('warn mode never hides a demo that is not ready', { timeout: LIMIT }, async () => {
  const s = setup();
  const silent = `process.on('SIGINT', () => process.exit(1)); setInterval(() => {}, 1000);`;
  const result = await runAgainstDemo(s.command(0), { launcher: s.launcher(fake(s.dir, 'demo', silent)), readyMs: 300, teardownFailure: 'warn', log: quiet });
  assert.match(result.problem.message, /not ready/);
  assert.ok(!fs.existsSync(s.ran));
  assert.notEqual(exitCodeOf(result), 0);
});

test('warn mode never hides a demo that does not stop', { timeout: LIMIT }, async () => {
  const s = setup();
  const stubborn = `console.log(${JSON.stringify(READY)}); process.on('SIGINT', () => {}); setInterval(() => {}, 1000);`;
  const result = await runAgainstDemo(s.command(0), { launcher: s.launcher(fake(s.dir, 'demo', stubborn)), stopMs: 300, teardownFailure: 'warn', log: quiet });
  assert.match(result.problem.message, /did not stop/);
  assert.notEqual(exitCodeOf(result), 0);
});

test('an unknown teardown mode is refused', { timeout: LIMIT }, async () => {
  await assert.rejects(() => runAgainstDemo(['true'], { teardownFailure: 'ignore', log: quiet }), /teardown mode/);
  assert.equal(teardownModeFrom({}), 'fail');
  assert.equal(teardownModeFrom({ PRODUCT_DEMO_TEARDOWN_FAILURE: 'warn' }), 'warn');
  assert.equal(teardownModeFrom({ PRODUCT_DEMO_TEARDOWN_FAILURE: 'fail' }), 'fail');
  assert.throws(() => teardownModeFrom({ PRODUCT_DEMO_TEARDOWN_FAILURE: 'skip' }), /PRODUCT_DEMO_TEARDOWN_FAILURE/);
});

// The real launcher: without being asked it prints only its generic line; asked, it adds the one-line reason (never a stack).
test('start.cjs names its reason only when asked', { timeout: LIMIT }, () => {
  const run = (extra) => spawnSync(process.execPath, [path.join(__dirname, 'start.cjs'), 'not-a-command'], { encoding: 'utf8', env: { ...process.env, ...extra } });
  const plain = run({ LOCAL_STORAGE_SHOW_REASON: '' });
  assert.equal(plain.status, 1);
  assert.match(plain.stderr, /Local storage operation failed; inspect private run\/control state\./);
  assert.doesNotMatch(plain.stderr, /Reason:/);
  const asked = run({ LOCAL_STORAGE_SHOW_REASON: '1' });
  assert.equal(asked.status, 1);
  assert.match(asked.stderr, /^Reason: Use start or teardown <run UUID>$/m);
  assert.doesNotMatch(asked.stderr, /\n\s+at /);
});
