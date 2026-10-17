import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, lstatSync, readFileSync, readdirSync, readlinkSync, renameSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const budgetMs = 30 * 60_000;
const refuse = () => { throw new Error('Service budget validation failed.'); };
export function exactKeys(value, names) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...names].sort())) refuse();
}
export function identityFromEnv(env) {
  const value = { repository: env.GITHUB_REPOSITORY, runId: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT,
    headSha: env.SERVICE_HEAD_SHA, checkout: env.GITHUB_SHA };
  if (!/^[\w.-]+\/[\w.-]+$/.test(value.repository ?? '')
    || ![value.runId, value.attempt].every(v => /^[1-9]\d*$/.test(v ?? '') && Number.isSafeInteger(Number(v)))
    || ![value.headSha, value.checkout].every(v => /^[a-f0-9]{40}$/.test(v ?? ''))) refuse();
  return value;
}
export function budgetFromRun(run, identity, now = Date.now()) {
  if (String(run.id) !== identity.runId || String(run.run_attempt) !== identity.attempt
    || run.head_sha !== identity.headSha || run.repository?.full_name !== identity.repository
    || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(run.run_started_at ?? '')) refuse();
  const startedMs = Date.parse(run.run_started_at);
  const budget = { format: 1, ...identity, startedMs, deadlineMs: startedMs + budgetMs };
  remainingMs(budget, now);
  return budget;
}
export function remainingMs(budget, now = Date.now()) {
  exactKeys(budget, ['format', 'repository', 'runId', 'attempt', 'headSha', 'checkout', 'startedMs', 'deadlineMs']);
  identityFromEnv({ GITHUB_REPOSITORY: budget.repository, GITHUB_RUN_ID: budget.runId, GITHUB_RUN_ATTEMPT: budget.attempt,
    SERVICE_HEAD_SHA: budget.headSha, GITHUB_SHA: budget.checkout });
  if (budget.format !== 1 || ![budget.startedMs, budget.deadlineMs, now].every(Number.isSafeInteger)
    || budget.deadlineMs - budget.startedMs !== budgetMs || now < budget.startedMs || now >= budget.deadlineMs) refuse();
  return budget.deadlineMs - now;
}
export function temporary(env) {
  const directory = env.RUNNER_TEMP;
  if (!directory || !isAbsolute(directory) || !lstatSync(directory).isDirectory()) refuse();
  return directory;
}
export function readJson(file) {
  const info = lstatSync(file);
  if (!info.isFile() || info.size > 2 * 1024 * 1024) refuse();
  return JSON.parse(readFileSync(file, 'utf8'));
}
export function loadBudget(env = process.env, now = Date.now()) {
  const budget = readJson(join(temporary(env), 'service-budget.json'));
  const identity = identityFromEnv(env);
  if (Object.entries(identity).some(([key, value]) => budget[key] !== value)) refuse();
  remainingMs(budget, now);
  if (env.SERVICE_WATCHDOG_REQUIRED === '1') validateWatchdog(env, budget, now);
  return budget;
}

const digest = value => createHash('sha256').update(value).digest('hex');
export const processKey = p => `${p.pid}:${p.start}`;
export function parseLinuxProcess(stat, uid) {
  const end = stat.lastIndexOf(')'); const pid = Number(stat.slice(0, stat.indexOf(' ')));
  const fields = stat.slice(end + 2).trim().split(/\s+/);
  if (end < 0 || fields.length < 20 || !Number.isSafeInteger(pid) || pid < 1 || !Number.isSafeInteger(uid) || uid < 0
    || !/^\d+$/.test(fields[1]) || !/^\d+$/.test(fields[19])) refuse();
  if (fields[0] === 'Z') return null;
  return { pid, ppid: Number(fields[1]), uid, start: fields[19], command: stat.slice(stat.indexOf('(') + 1, end) };
}
function parseDarwinProcesses(output) {
  const records = [];
  for (const line of output.trim().split('\n')) {
    if (!line.trim()) continue;
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\w+\s+\w+\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.+)$/);
    if (!m) refuse();
    if (!m[4].startsWith('Z')) records.push({ pid: Number(m[1]), ppid: Number(m[2]), uid: Number(m[3]), start: m[5], command: basename(m[6]) });
  }
  return new Map(records.map(p => [p.pid, p]));
}
export function readProcess(pid, platform = process.platform, proc = '/proc') {
  if (!Number.isSafeInteger(pid) || pid < 1) refuse();
  try {
    if (platform === 'linux') {
      const directory = join(proc, String(pid));
      const p = parseLinuxProcess(readFileSync(join(directory, 'stat'), 'utf8'), lstatSync(directory).uid);
      if (p && p.uid === process.getuid()) {
        // Executable inspection has stricter Linux permissions than core identity/signal checks.
        // Retain cleanup identities when it is unavailable, but never trust mutable comm as an owner.
        p.command = '';
        try { p.command = basename(readlinkSync(join(directory, 'exe'))); }
        catch (error) { if (!['EACCES', 'EPERM', 'ENOENT', 'ESRCH'].includes(error.code)) throw error; }
      }
      return p;
    }
    if (platform === 'darwin') return parseDarwinProcesses(execFileSync('/bin/ps', ['-p', String(pid), '-o', 'pid=,ppid=,uid=,stat=,lstart=,comm='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).get(pid);
    refuse();
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH' || (platform === 'darwin' && error.status === 1)) return null;
    throw error;
  }
}
export function readProcesses(platform = process.platform, proc = '/proc') {
  if (platform === 'darwin') return parseDarwinProcesses(execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,uid=,stat=,lstart=,comm='], { encoding: 'utf8' }));
  if (platform !== 'linux') refuse();
  const records = [];
  for (const name of readdirSync(proc)) {
    if (!/^[1-9]\d*$/.test(name)) continue;
    const p = readProcess(Number(name), platform, proc); if (p) records.push(p);
  }
  return new Map(records.map(p => [p.pid, p]));
}
export function selectNewProcesses(table, baseline, uid, excluded = new Set()) {
  return [...table.values()].filter(p => p.uid === uid && !excluded.has(p.pid) && processKey(baseline.get(p.pid) ?? {}) !== processKey(p));
}
export function selectDescendants(table, known) {
  const selected = new Map([...known].filter(([pid, p]) => table.get(pid) && processKey(table.get(pid)) === processKey(p)));
  let changed;
  do {
    changed = false;
    for (const p of table.values()) if (!selected.has(p.pid) && selected.has(p.ppid)) { selected.set(p.pid, p); changed = true; }
  } while (changed);
  return [...selected.values()];
}
export function signalIdentity(p, signal, { read = readProcess, kill = process.kill } = {}) {
  if (!p || p.pid <= 1 || p.pid === process.pid) return false;
  const current = read(p.pid);
  if (!current || current.uid !== p.uid || processKey(current) !== processKey(p)) return false;
  try { kill(p.pid, signal); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
const delay = ms => new Promise(r => setTimeout(r, ms));
/** Freeze the captured descendants before losing ancestry, then give TERM a bounded cleanup grace. */
export async function terminateProcesses(select, { read = readProcesses, signal = signalIdentity, graceMs = 500 } = {}) {
  const known = new Map();
  const capture = () => { for (const p of select(read())) known.set(p.pid, p); return [...known.values()]; };
  const initial = capture(); if (!initial.length) return;
  for (const p of initial) signal(p, 'SIGSTOP');
  for (const p of capture()) signal(p, 'SIGTERM');
  for (const p of known.values()) signal(p, 'SIGCONT');
  const end = Date.now() + graceMs;
  do {
    await delay(Math.min(25, Math.max(1, end - Date.now())));
    for (const p of capture()) if (!signal(p, 'SIGTERM')) known.delete(p.pid);
  } while (Date.now() < end);
  for (const p of capture()) signal(p, 'SIGKILL');
}
export function hostedOwner(env, table = readProcesses(), platform = process.platform, uid = process.getuid?.()) {
  if (platform !== 'linux' || env.RUNNER_ENVIRONMENT !== 'github-hosted' || env.RUNNER_OS !== 'Linux' || env.RUNNER_ARCH !== 'X64' || !uid) refuse();
  let p = table.get(process.pid); const seen = new Set();
  while (p && !seen.has(p.pid)) {
    seen.add(p.pid);
    if (p.command === 'Runner.Worker' && p.uid === uid && p.pid !== process.pid) return p;
    p = table.get(p.ppid);
  }
  refuse();
}
function atomicJson(file, value) {
  const temporaryFile = file + '.' + process.pid;
  writeFileSync(temporaryFile, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' }); renameSync(temporaryFile, file);
}
export function validateWatchdog(env, budget, now = Date.now(), read = readProcess) {
  const receipt = readJson(join(temporary(env), 'service-watchdog.json'));
  exactKeys(receipt, ['format', 'state', 'pid', 'start', 'owner', 'budgetHash', 'sourceHash', 'heartbeatMs']);
  exactKeys(receipt.owner, ['pid', 'ppid', 'uid', 'start', 'command']);
  const current = read(receipt.pid), owner = read(receipt.owner.pid);
  if (receipt.format !== 1 || receipt.state !== 'armed' || !current || current.start !== receipt.start || !owner
    || processKey(owner) !== processKey(receipt.owner) || owner.command !== 'Runner.Worker'
    || current.uid !== process.getuid() || owner.uid !== current.uid || receipt.budgetHash !== digest(JSON.stringify(budget))
    || receipt.sourceHash !== digest(readFileSync(fileURLToPath(import.meta.url)))
    || !Number.isSafeInteger(receipt.heartbeatMs) || receipt.heartbeatMs > now || now - receipt.heartbeatMs > 5000) refuse();
  return receipt;
}
/** A dedicated hosted VM makes new same-UID processes attributable even after reparenting/setsid. */
export async function watchJob({ budget, owner, baseline, uid, directory, read = readProcesses, signal = signalIdentity,
  now = Date.now, sourceHash = digest(readFileSync(fileURLToPath(import.meta.url))), onReady = () => {}, shutdownGraceMs = 5000 }) {
  const self = readProcess(process.pid); if (!self) refuse();
  remainingMs(budget, now());
  const receipt = { format: 1, state: 'armed', pid: process.pid, start: self.start, owner, budgetHash: digest(JSON.stringify(budget)), sourceHash, heartbeatMs: now() };
  const file = join(directory, 'service-watchdog.json');
  const publish = () => { receipt.heartbeatMs = now(); atomicJson(file, receipt); };
  const sameOwner = table => table.get(owner.pid) && processKey(table.get(owner.pid)) === processKey(owner);
  const targets = table => selectNewProcesses(table, baseline, uid, new Set([process.pid, owner.pid]));
  let table = read(); if (!sameOwner(table)) refuse();
  // Supervision errors must retain the same bounded shutdown as expiry, even if receipts cannot be written.
  const shutdown = async () => {
    let failed = false;
    const snapshot = () => { try { table = read(); } catch { failed = true; } return table; };
    const send = (p, kind) => { try { return signal(p, kind); } catch { failed = true; return false; } };
    send(owner, 'SIGTERM');
    try {
      try { await terminateProcesses(targets, { read: snapshot, signal: send }); } catch { failed = true; }
      const end = Date.now() + shutdownGraceMs;
      while (sameOwner(snapshot()) && Date.now() < end) {
        for (const p of targets(table)) send(p, 'SIGKILL');
        await delay(25);
      }
    } finally {
      // Always attempt escalation. Cached entries still pass live PID/start/UID checks before a signal.
      if (sameOwner(snapshot())) send(owner, 'SIGKILL');
      for (const p of targets(snapshot())) send(p, 'SIGKILL');
    }
    return !failed;
  };
  publish(); onReady();
  let interrupt = false;
  const stop = () => { interrupt = true; };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  try {
    while (sameOwner(table = read())) {
      if (interrupt || now() < budget.startedMs || now() >= budget.deadlineMs) {
        receipt.state = 'expired'; publish();
        // Runner.Worker handles SIGTERM by cancelling its linked job token (Worker_Unloading).
        if (!await shutdown()) {
          receipt.state = 'failed'; try { publish(); } catch { /* shutdown already attempted */ }
          return 1;
        }
        return 124;
      }
      publish(); await delay(Math.min(250, budget.deadlineMs - now()));
    }
    await terminateProcesses(targets, { read, signal });
    receipt.state = 'stopped'; publish(); return 0;
  } catch {
    receipt.state = 'failed'; try { publish(); } catch { /* failure still cancels the job */ }
    await shutdown(); return 1;
  } finally { process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); }
}
export async function requestBudget(env = process.env, request = fetch, now = Date.now) {
  const identity = identityFromEnv(env);
  if (!env.GH_TOKEN || env.GITHUB_API_URL !== 'https://api.github.com') refuse();
  const response = await request(`${env.GITHUB_API_URL}/repos/${identity.repository}/actions/runs/${identity.runId}/attempts/${identity.attempt}`, {
    headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10' },
    redirect: 'error', signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) refuse();
  return budgetFromRun(await response.json(), identity, now());
}
export async function bootstrap(env = process.env, request = fetch, now = Date.now) {
  // Never run machine-wide cleanup on a workstation, self-hosted runner or shared container runner.
  if (!isAbsolute(env.GITHUB_OUTPUT ?? '')) refuse();
  const baseline = readProcesses(); const owner = hostedOwner(env, baseline);
  const budget = await requestBudget(env, request, now);
  const directory = temporary(env);
  writeFileSync(join(directory, 'service-budget.json'), JSON.stringify(budget) + '\n', { mode: 0o600, flag: 'wx' });
  const self = fileURLToPath(import.meta.url);
  const ticket = join(directory, 'service-watchdog-ticket.json');
  writeFileSync(ticket, JSON.stringify({ budget, owner, baseline: [...baseline], uid: process.getuid() }) + '\n', { mode: 0o600, flag: 'wx' });
  // No token/caller environment or runner tracking marker. It must survive orphan cleanup until the owner exits.
  const child = spawn(process.execPath, [self, 'watch'], { detached: true, stdio: ['ignore', 'ignore', 'ignore'],
    env: { PATH: env.PATH, RUNNER_TEMP: directory,
      RUNNER_ENVIRONMENT: env.RUNNER_ENVIRONMENT, RUNNER_OS: env.RUNNER_OS, RUNNER_ARCH: env.RUNNER_ARCH } });
  let childFailed = false; child.once('error', () => { childFailed = true; });
  child.unref();
  const until = Math.min(now() + 5000, budget.deadlineMs);
  while (!childFailed && now() < until) {
    try { validateWatchdog(env, budget, now());
      if (!isAbsolute(env.GITHUB_OUTPUT ?? '')) refuse();
      appendFileSync(env.GITHUB_OUTPUT, 'armed=true\n'); return budget;
    } catch { await delay(20); }
  }
  if (child.pid) { const p = readProcess(child.pid); if (p) signalIdentity(p, 'SIGTERM'); }
  throw new Error('Service watchdog did not arm.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) refuse();
    if (process.argv[2] === 'bootstrap') await bootstrap();
    else if (process.argv[2] === 'watch') {
      const directory = temporary(process.env); const ticket = readJson(join(directory, 'service-watchdog-ticket.json'));
      exactKeys(ticket, ['budget', 'owner', 'baseline', 'uid']);
      const record = readJson(join(directory, 'service-budget.json'));
      exactKeys(record, Object.keys(ticket.budget));
      if (Object.keys(record).some(k => record[k] !== ticket.budget[k])) refuse();
      const table = readProcesses(); const owner = hostedOwner(process.env, table);
      if (processKey(owner) !== processKey(ticket.owner) || ticket.uid !== process.getuid()) refuse();
      process.exitCode = await watchJob({ ...ticket, baseline: new Map(ticket.baseline), directory });
    } else refuse();
  } catch { process.stderr.write('Service deadline supervision failed.\n'); process.exitCode = 1; }
}
