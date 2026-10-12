// Native regression for admission persistence and the real foreground supervisor.
// Requires explicit local runtimes; no service discovery skips or shared resources.
const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const o = require('./ownership.cjs'); const runtime = require('./runtime.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function bounded(promise, ms) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Recovery regression deadline')), ms); })]); }
  finally { clearTimeout(timer); }
}
async function recovery(record = () => {}) {
  o.ensureBase();
  for (const port of Object.values(runtime.ports)) await o.free(port);
  const child = spawn(process.execPath, [path.join(__dirname, 'start.cjs'), 'start'], { cwd: o.root, env: process.env, stdio: ['ignore', 'pipe', 'ignore'] });
  let output = '', id, exit, statusFile, original;
  const end = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => { exit = { code, signal }; resolve(exit); }); });
  child.stdout.on('data', bytes => { output += bytes; id = /run ([a-f0-9-]{36})/.exec(output)?.[1]; });
  try {
    for (let n = 0; !id && n < 600; n++) { if (exit) throw new Error('Recovery launcher exited before readiness'); await sleep(100); }
    assert.ok(id, 'Recovery fixture readiness');
    let m = o.load(id);
    statusFile = path.join(m.root, 'sweeps.json'); original = o.read(statusFile);
    // Written blast radius: replace only this generated run's synthetic status
    // file with an empty directory; restore it before official owned teardown.
    fs.unlinkSync(statusFile); fs.mkdirSync(statusFile, { mode: 0o700 });
    try {
      const api = m.processes.find(p => p.name === 'api'); assert.equal(o.live(api), true); process.kill(api.pid, 'SIGUSR2');
      for (let n = 0; n < 200 && runtime.listener(m, 'api'); n++) await sleep(50);
      assert.equal(runtime.listener(m, 'api'), false, 'Failed persistence must close admission');
      await assert.rejects(fetch(`http://127.0.0.1:${m.ports.api}/api/v1/health`, { signal: AbortSignal.timeout(2000) }));
      assert.deepEqual(fs.readdirSync(m.root).filter(name => name.startsWith('sweeps.json.')), [], 'No failed-write temporaries');
      assert.equal(o.load(id).phase, 'ready', 'Ownership remains recoverable');
      assert.equal(exit, undefined, 'Status failure does not lose the supervisor');
    } finally { fs.rmdirSync(statusFile); o.atomic(statusFile, original); original = undefined; }
    const result = await runtime.sweepNow(id); assert.equal(result.success, true); assert.equal(runtime.listener(m, 'api'), true);
    record('durable-status-failure-closes-admission-retry-reopens', { passed: true, noTemporaryFiles: true, actualApiListener: true });

    // Deterministically hold the same maintenance lock across a stopped API for
    // more than two supervisor ticks. This reproduces the original restart window.
    const unlock = o.lock(id);
    try {
      await runtime.stop(m.processes.find(p => p.name === 'api'));
      await sleep(2200);
      assert.equal(exit, undefined, 'Planned maintenance must preserve the supervisor');
      assert.equal(runtime.health(id), 'busy');
    } finally { unlock(); }
    m = await runtime.restartApi(id);
    for (let n = 0; n < 3; n++) {
      execFileSync(process.execPath, [path.join(__dirname, 'start.cjs'), 'restart-api', id], { cwd: o.root, env: process.env, stdio: 'ignore', timeout: 60000 });
      await sleep(1100);
      assert.equal(exit, undefined, 'Restart CLI must preserve the foreground launcher');
      m = o.load(id); assert.equal(m.phase, 'ready'); assert.equal(m.processes.every(o.live), true); assert.equal(runtime.listener(m, 'api'), true);
    }
    record('foreground-maintenance-and-repeated-api-restarts', { passed: true, cliRestarts: 3, maintenanceTicks: 2, workersLive: 5 });
    child.kill('SIGTERM'); const stopped = await bounded(end, 60000);
    assert.equal(stopped.code, 0); assert.equal(o.load(id).phase, 'removed');
    record('foreground-recovery-normal-shutdown', { passed: true, exitCode: 0 });
  } finally {
    if (id && original !== undefined) {
      if (fs.lstatSync(statusFile).isDirectory()) fs.rmdirSync(statusFile);
      o.atomic(statusFile, original);
    }
    if (!exit) { child.kill('SIGTERM'); await bounded(end, 60000); }
    if (id) await runtime.teardown(id);
    for (const port of Object.values(runtime.ports)) await o.free(port);
  }
}
if (require.main === module) {
  const results = [];
  recovery((name, detail) => { results.push({ name, ...detail }); console.log(name + ': passed'); })
    .then(() => {
      const file = process.env.L3_RECOVERY_EVIDENCE || path.join(o.base, 'recovery.json');
      o.atomic(file, JSON.stringify({ status: 'passed', gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: o.root, encoding: 'utf8' }).trim(), checks: results, remainingOwnedRuns: fs.readdirSync(path.join(o.base, 'runs')).length }, null, 2));
    }).catch(error => { console.error('Owned recovery regression failed: ' + error.name); process.exitCode = 1; });
}
module.exports = { recovery };
