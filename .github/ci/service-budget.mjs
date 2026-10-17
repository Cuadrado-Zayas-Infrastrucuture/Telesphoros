import { spawn, execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadBudget, remainingMs, requestBudget, temporary, identityFromEnv, readProcesses, readProcess, selectDescendants, terminateProcesses, signalIdentity } from './service-deadline.mjs';
export { budgetMs, exactKeys, identityFromEnv, budgetFromRun, remainingMs, temporary, readJson, loadBudget } from './service-deadline.mjs';
export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const refuse = () => { throw new Error('Service budget validation failed.'); };

export async function initialize(env = process.env, request = fetch, now = Date.now) {
  const identity = identityFromEnv(env);
  const checkout = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  if (checkout !== identity.checkout || !isAbsolute(env.GITHUB_OUTPUT ?? '')) refuse();
  let budget;
  if (env.SERVICE_WATCHDOG_REQUIRED === '1') {
    // The first step already fetched and armed this attempt's deadline; setup must never reset it.
    budget = loadBudget(env, now());
  } else {
    budget = await requestBudget(env, request, now);
    writeFileSync(join(temporary(env), 'service-budget.json'), JSON.stringify(budget) + '\n', { mode: 0o600, flag: 'wx' });
  }
  appendFileSync(env.GITHUB_OUTPUT, `minutes=${Math.ceil(remainingMs(budget, now()) / 60_000)}\n`);
  return budget;
}

/** Track identities across groups/reparenting, freeze descendants before killing their parents. */
export async function runScript(script, budget, { env = process.env, cwd = root, now = Date.now } = {}) {
  const duration = remainingMs(budget, now());
  if (!script.trim()) refuse();
  // Prove inspection works before starting any producer; restricted hosts fail without an untracked child.
  let lastTable = readProcesses();
  return new Promise(resolveResult => {
    let reason = 0, exitStatus, cleanup, cleanupDone = false, finished = false;
    const known = new Map();
    const child = spawn('bash', ['-e', '-o', 'pipefail', '-c', script], { cwd, env, stdio: 'inherit', detached: true });
    const select = table => {
      const records = selectDescendants(table, known);
      for (const p of records) known.set(p.pid, p);
      return records;
    };
    const observe = () => { lastTable = readProcesses(); select(lastTable); };
    const complete = () => {
      if (finished || !cleanupDone || exitStatus === undefined) return;
      finished = true;
      clearTimeout(timer); clearInterval(poll);
      process.removeListener('SIGTERM', interrupt); process.removeListener('SIGINT', interrupt);
      resolveResult(reason || exitStatus);
    };
    const stop = code => {
      reason ||= code;
      clearTimeout(timer); clearInterval(poll);
      cleanup ??= terminateProcesses(select, { read: () => {
        try { lastTable = readProcesses(); } catch { reason ||= 1; for (const [pid, p] of known) lastTable.set(pid, p); }
        return lastTable;
      } }).catch(() => { reason ||= 1; for (const p of known.values()) { try { signalIdentity(p, 'SIGKILL'); } catch { /* global hosted watchdog also owns expiry */ } } }).finally(() => { cleanupDone = true; complete(); });
    };
    const interrupt = () => stop(1);
    const timer = setTimeout(() => stop(124), duration);
    const poll = setInterval(() => { try { observe(); } catch { stop(1); } }, 100);
    process.on('SIGTERM', interrupt); process.on('SIGINT', interrupt);
    if (child.pid) {
      try { const p = readProcess(child.pid); if (p) known.set(p.pid, p); observe(); } catch { stop(1); }
    }
    child.once('error', () => { exitStatus = 1; stop(0); complete(); });
    child.once('exit', (code, signal) => {
      exitStatus = signal ? 1 : (code ?? 1);
      if (exitStatus === 0 && !reason) {
        // Successful setup may intentionally leave Moto running for later steps. The job watchdog owns it.
        // Recheck the absolute clock before handing it over; a delayed exit callback grants no extra time.
        try { remainingMs(budget, now()); cleanupDone = true; complete(); }
        catch { stop(124); }
      } else { stop(0); complete(); }
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.versions.node !== '22.22.0' || process.argv.length !== 3) refuse();
    const command = process.argv[2];
    if (command === 'init') await initialize();
    else if (command === 'check') loadBudget();
    else if (command === 'run') process.exitCode = await runScript(readFileSync(0, 'utf8'), loadBudget());
    else refuse();
  } catch {
    // Never serialize API bodies, headers, environment values or filesystem errors.
    process.stderr.write('Service budget command failed.\n'); process.exitCode = 1;
  }
}
