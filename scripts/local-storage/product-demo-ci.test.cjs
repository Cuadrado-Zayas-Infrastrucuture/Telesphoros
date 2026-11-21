const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runAgainstDemo, exitCodeOf } = require('./product-demo-ci.cjs');

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
