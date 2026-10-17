import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runScript } from './service-budget.mjs';
import { budgetMs, readProcess, signalIdentity, watchJob } from './service-deadline.mjs';

const delay = ms => new Promise(r => setTimeout(r, ms));
const quote = v => "'" + v.replaceAll("'", "'\\''") + "'";
const clock = (remaining = 10000) => {
  const deadlineMs = Date.now() + remaining;
  return { format: 1, repository: 'owner/repo', runId: '1', attempt: '1', headSha: 'a'.repeat(40), checkout: 'b'.repeat(40), startedMs: deadlineMs - budgetMs, deadlineMs };
};
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'service-lifecycle-'));
  // Deletion is limited to this generated synthetic fixture directory; no existing data or service belongs here.
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
async function ready(check) {
  for (let i = 0; i < 300; i++) { if (check()) return; await delay(10); }
  assert.fail('Finite synthetic child did not become ready.');
}
async function killed(p) {
  // kill(2) accepts a signal before the kernel schedules process exit. Keep the
  // existing finite wait, then require SIGKILL rather than the fixture's fallback exit.
  await ready(() => p.exitCode !== null || p.signalCode !== null);
  assert.equal(p.signalCode, 'SIGKILL');
  assert.ok(!readProcess(p.pid), 'the killed identity must no longer be live');
}
function child(t, code) {
  const p = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 8000);\n' + code], { stdio: 'ignore' });
  const exited = new Promise(r => p.once('exit', r));
  const identity = readProcess(p.pid);
  t.after(async () => { if (identity) signalIdentity(identity, 'SIGKILL'); await exited; });
  return p;
}
function service(t, directory) {
  const bin = join(directory, 'bin'); mkdirSync(bin);
  const pidFile = join(directory, 'service-pid'), readyFile = join(directory, 'service-ready');
  const executable = (name, text) => writeFileSync(join(bin, name), text, { mode: 0o700 });
  // No network port, package install or real service. Readiness is delayed so the wrapper observes the child.
  executable('pip', '#!/bin/sh\nexit 0\n');
  executable('moto_server', '#!' + process.execPath + '\n' + `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setTimeout(()=>fs.writeFileSync(${JSON.stringify(readyFile)},'ready'),350);setInterval(()=>{},1000);setTimeout(()=>process.exit(0),8000);`);
  executable('curl', '#!/bin/sh\ntest -f ' + quote(readyFile) + '\n');
  const workflow = readFileSync(new URL('../workflows/ci.yml', import.meta.url), 'utf8');
  const scripts = [...workflow.matchAll(/node \.github\/ci\/service-budget\.mjs run <<'BUDGET'\n(          pip install -r \.github\/ci\/requirements\.txt\n          moto_server[\s\S]*?)^          BUDGET/gm)].map(m => m[1].replace(/^ {10}/gm, ''));
  assert.equal(scripts.length, 4); assert.ok(scripts.every(s => s === scripts[0]));
  let identity;
  const processIdentity = () => {
    if (!identity && existsSync(pidFile)) identity = readProcess(Number(readFileSync(pidFile)));
    return identity;
  };
  t.after(() => { const p = processIdentity(); if (p) signalIdentity(p, 'SIGKILL'); });
  return { script: scripts[0], env: { PATH: bin + ':' + process.env.PATH }, processIdentity, pidFile, readyFile };
}

test('successful Moto setup preserves the service for later steps and the job watchdog owns final cleanup', async t => {
  const directory = fixture(t), s = service(t, directory), done = join(directory, 'job-done'), ownerReady = join(directory, 'owner-ready');
  const owner = child(t, `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(ownerReady)},'ready');setInterval(()=>{if(fs.existsSync(${JSON.stringify(done)}))process.exit(0);},10);`);
  await ready(() => existsSync(ownerReady));
  const allowed = new Set([process.pid, owner.pid]);
  const read = () => new Map([...allowed].map(pid => [pid, readProcess(pid)]).filter(([, p]) => p));
  const baseline = read();
  assert.equal(await runScript(s.script, clock(), { cwd: directory, env: s.env }), 0);
  assert.ok(existsSync(s.readyFile));
  const daemon = s.processIdentity(); assert.ok(daemon, 'successful setup must leave Moto alive for later profiles');
  allowed.add(daemon.pid);
  assert.equal(await watchJob({ budget: clock(), owner: baseline.get(owner.pid), baseline, uid: process.getuid(), directory, read,
    onReady: () => writeFileSync(done, 'done') }), 0);
  assert.ok(!readProcess(daemon.pid), 'job completion must still clean the persistent setup service');
});

test('failed setup preserves native exit 17 and cleans its background service', async t => {
  const directory = fixture(t), s = service(t, directory);
  assert.equal(await runScript(s.script.replace('&& exit 0', '&& exit 17'), clock(), { cwd: directory, env: s.env }), 17);
  assert.ok(existsSync(s.pidFile)); assert.ok(!readProcess(Number(readFileSync(s.pidFile))));
});

test('a successful shell cannot preserve its service after the shared deadline', async t => {
  const directory = fixture(t), s = service(t, directory), budget = clock(); let reads = 0;
  const now = () => ++reads === 1 ? budget.deadlineMs - 5000 : budget.deadlineMs;
  assert.equal(await runScript(s.script, budget, { cwd: directory, env: s.env, now }), 124);
  assert.ok(!readProcess(Number(readFileSync(s.pidFile))));
});

async function errorControl(t, mode, deferOwnerKill = false) {
  const directory = fixture(t), ownerReady = join(directory, 'owner-ready'), term = join(directory, 'term');
  const latePid = join(directory, 'late-pid');
  const owner = child(t, `const fs=require('node:fs');let stopped=false;process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(term)},'received');if(!stopped){stopped=true;setTimeout(()=>{const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000);setTimeout(()=>process.exit(0),6000);'],{detached:true,stdio:'ignore',env:{PATH:process.env.PATH}});fs.writeFileSync(${JSON.stringify(latePid)},String(c.pid));c.unref();},650);}});fs.writeFileSync(${JSON.stringify(ownerReady)},'ready');`);
  await ready(() => existsSync(ownerReady));
  const allowed = new Set([process.pid, owner.pid]); let lateIdentity;
  const snapshot = () => {
    if (!lateIdentity && existsSync(latePid)) { lateIdentity = readProcess(Number(readFileSync(latePid))); if (lateIdentity) allowed.add(lateIdentity.pid); }
    return new Map([...allowed].map(pid => [pid, readProcess(pid)]).filter(([, p]) => p));
  };
  t.after(() => { snapshot(); if (lateIdentity) signalIdentity(lateIdentity, 'SIGKILL'); });
  const baseline = snapshot();
  const actionReady = join(directory, 'action-ready');
  const action = child(t, `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(actionReady)},'ready');`);
  allowed.add(action.pid); await ready(() => existsSync(actionReady));
  let armed = false, readFailures = 0;
  const read = () => {
    // Record the action before an injected scan failure; only explicitly owned PIDs ever enter this table.
    const table = snapshot();
    if (armed && mode !== 'heartbeat' && (mode === 'persistent-scan' || !readFailures)) { readFailures++; throw new Error('synthetic scan failure'); }
    return table;
  };
  const onReady = () => {
    if (mode === 'heartbeat') writeFileSync(join(directory, 'service-watchdog.json.' + process.pid), 'synthetic write fault', { flag: 'wx' });
    else armed = true;
  };
  const signals = [];
  const signal = (p, kind) => {
    signals.push([p.pid, kind]);
    // Exercise asynchronous delivery independently of the host's /proc or ps speed.
    if (deferOwnerKill && p.pid === owner.pid && kind === 'SIGKILL') {
      setTimeout(() => signalIdentity(p, kind), 40); return true;
    }
    return signalIdentity(p, kind);
  };
  assert.equal(await watchJob({ budget: clock(1500), owner: baseline.get(owner.pid), baseline, uid: process.getuid(), directory, read, signal,
    shutdownGraceMs: 600, onReady }), 1);
  assert.ok(existsSync(term)); await killed(owner);
  await killed(action);
  assert.ok(signals.some(([pid, kind]) => pid === owner.pid && kind === 'SIGKILL'));
  if (mode !== 'persistent-scan') {
    assert.ok(existsSync(latePid), 'fixture must exercise work born during worker shutdown');
    const pid = Number(readFileSync(latePid));
    assert.ok(signals.some(([target, kind]) => target === pid && kind === 'SIGKILL'));
    await ready(() => !readProcess(pid));
    assert.ok(!readProcess(pid), 'shutdown must sweep late detached work');
  }
}
test('heartbeat write errors retain bounded owner shutdown and sweep late detached work', async t => errorControl(t, 'heartbeat'));
test('transient process-scan errors retain bounded owner shutdown and sweep late detached work', async t => errorControl(t, 'transient-scan'));
test('delayed owner KILL delivery still requires actual SIGKILL exit and late-work cleanup', async t => errorControl(t, 'transient-scan', true));
test('persistent process-scan errors retain bounded shutdown using verified cached identities', async t => errorControl(t, 'persistent-scan'));

test('a failed TERM attempt cannot bypass the owner KILL fallback', async t => {
  const directory = fixture(t), ownerReady = join(directory, 'owner-ready');
  const owner = child(t, `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(ownerReady)},'ready');`);
  await ready(() => existsSync(ownerReady));
  const read = () => new Map([process.pid, owner.pid].map(pid => [pid, readProcess(pid)]).filter(([, p]) => p));
  const baseline = read(); const signals = [];
  const signal = (p, kind) => { signals.push(kind); if (kind === 'SIGTERM' && p.pid === owner.pid) throw new Error('synthetic TERM error'); return signalIdentity(p, kind); };
  assert.equal(await watchJob({ budget: clock(80), owner: baseline.get(owner.pid), baseline, uid: process.getuid(), directory, read, signal,
    shutdownGraceMs: 80 }), 1);
  assert.ok(signals.includes('SIGKILL')); await killed(owner);
});
