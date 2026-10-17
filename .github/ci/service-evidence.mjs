import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { exactKeys, loadBudget, readJson, remainingMs, root, runScript, temporary } from './service-budget.mjs';
import { verifyAllProfiles, verifyRecoveryMetrics } from './verify-recovery-metrics.mjs';
import { verifyApplicationProfiles, verifyApplicationRecovery } from './verify-application-recovery.mjs';

export const profiles = { memory: 'service-memory', postgres: 'service-postgres', 'postgres-s3': 'service-postgres-s3' };
const logs = { memory: 'tier1.log', postgres: 'tier2.log', 'postgres-s3': 'tier3.log', worker: 'tier-worker.log' };
const families = ['evidence-catalogue', 'independent-recovery', 'application-recovery'];
const refuse = () => { throw new Error('Service evidence validation failed.'); };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const writeJson = (file, value) => writeFileSync(file, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' });
const safeFile = file => { if (!lstatSync(file).isFile()) refuse(); };
export const metricFiles = profile => families.map(f => `${f}-${profile}.json`);

function metricFence(profile, cwd) {
  const directory = join(cwd, 'apps/backend/test-results'); mkdirSync(directory, { recursive: true });
  if (!lstatSync(directory).isDirectory()) refuse();
  // Files left by any earlier producer cannot satisfy this invocation, even with recent timestamps.
  for (const name of metricFiles(profile)) {
    try { lstatSync(join(directory, name)); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    refuse();
  }
  // Compare inode times on the output filesystem, not its coarse clock with Date.now().
  const marker = join(directory, '.service-evidence-fence-' + randomUUID());
  writeFileSync(marker, 'fence\n', { mode: 0o600, flag: 'wx' });
  try { const info = lstatSync(marker, { bigint: true }); if (!info.isFile()) refuse(); return info; }
  finally { unlinkSync(marker); } // Only this invocation's exclusively created marker is removed.
}

export function validateNeeds(needs) {
  exactKeys(needs, Object.values(profiles));
  for (const job of Object.values(profiles)) if (needs[job]?.result !== 'success') refuse();
}
function counts(line, worker = false) {
  const value = { passed: Number(line.match(/(\d+) passed/)?.[1] ?? 0), skipped: Number(line.match(/(\d+) skipped/)?.[1] ?? 0),
    failed: Number(line.match(/(\d+) failed/)?.[1] ?? 0), total: Number(line.match(worker ? /\((\d+)\)\s*$/ : /(\d+) total\s*$/)?.[1] ?? 0) };
  if (!Object.values(value).every(Number.isSafeInteger) || value.failed || !value.passed
    || value.passed + value.skipped !== value.total) refuse();
  return value;
}
export function parseSummary(text, worker = false) {
  const lines = stripVTControlCharacters(text).split(/\r?\n/).map(l => l.trim());
  if (lines.some(l => l.includes('NOT RUNNING'))) refuse();
  const suites = lines.filter(l => (worker ? /^Test Files\s/ : /^Test Suites:/).test(l));
  const tests = lines.filter(l => (worker ? /^Tests\s+\d/ : /^Tests:/).test(l));
  if (suites.length !== 1 || tests.length !== 1) refuse();
  const files = lines.map(l => l.match(worker ? /^[✓✔]\s+((?:test|src)\/\S+\.test\.ts)\s+\(\d+ tests?\)/
    : /^PASS\s+((?:test|src)\/\S+\.(?:spec|e2e-spec|pg-spec|s3-spec)\.ts)(?:\s+\([^)]*\))?$/)?.[1]).filter(Boolean).sort();
  const summary = { suites: counts(suites[0], worker), tests: counts(tests[0], worker), files };
  validateSummary(summary);
  return summary;
}
function validateSummary(summary) {
  exactKeys(summary, ['suites', 'tests', 'files']);
  for (const c of [summary.suites, summary.tests]) {
    exactKeys(c, ['passed', 'skipped', 'failed', 'total']);
    if (!Object.values(c).every(v => Number.isSafeInteger(v) && v >= 0) || !c.passed || c.failed || c.passed + c.skipped !== c.total) refuse();
  }
  if (!Array.isArray(summary.files) || summary.files.length !== summary.suites.passed || new Set(summary.files).size !== summary.files.length
    || summary.files.some(p => !/^(?:test|src)\/[\w./-]+\.(?:ts)$/.test(p) || p.split('/').includes('..'))) refuse();
}
function volume(v, objects = false) {
  exactKeys(v, objects ? ['bytes', 'GB', 'GiB', 'objects'] : ['bytes', 'GB', 'GiB']);
  if (!Number.isSafeInteger(v.bytes) || v.bytes < 0 || v.GB !== v.bytes / 1e9 || v.GiB !== v.bytes / 1024 ** 3
    || (objects && (!Number.isSafeInteger(v.objects) || v.objects < 0))) refuse();
}
function catalogue(value) {
  exactKeys(value, ['format', 'synthetic', 'status', 'controls', 'runtime', 'sourceDatabase', 'measurements', 'independentBytesRecovered', 'applicationRecoveryComplete']);
  exactKeys(value.runtime, ['node', 'platform', 'architecture', 'gitHead', 'storage']);
  if (value.independentBytesRecovered !== false || value.applicationRecoveryComplete !== false
    || value.runtime.storage !== 'loopback PostgreSQL/Moto; metadata only' || value.measurements?.length !== 3) refuse();
  volume(value.sourceDatabase);
  for (const metric of value.measurements) {
    exactKeys(metric, ['format', 'references', 'uniqueObjects', 'uncompletedRegistrations', 'orphanTextObjects', 'copiedObjectsVerified',
      'copiedBytesVerified', 'requiredByKind', 'volumes', 'seconds', 'concurrency', 'independentBytesRecovered', 'applicationRecoveryComplete']);
    if (metric.format !== 1 || metric.concurrency !== 1 || metric.independentBytesRecovered !== false || metric.applicationRecoveryComplete !== false) refuse();
    for (const key of ['references', 'uniqueObjects', 'uncompletedRegistrations', 'orphanTextObjects', 'copiedObjectsVerified', 'copiedBytesVerified']) {
      if (!Number.isSafeInteger(metric[key]) || metric[key] < 0) refuse();
    }
    exactKeys(metric.requiredByKind, ['lab-pdf', 'vcf', 'structured', 'text']);
    for (const v of Object.values(metric.requiredByKind)) volume(v, true);
    exactKeys(metric.volumes, ['restoredDatabase', 'archive', 'catalogue', 'requiredObjects', 'read', 'writeAttempted']);
    for (const v of Object.values(metric.volumes)) volume(v);
    exactKeys(metric.seconds, ['restoreAndInventory', 'resolve', 'copyAndVerify', 'publish', 'total']);
    if (Object.values(metric.seconds).some(v => !Number.isFinite(v) || v < 0)) refuse();
  }
}
export function validateMetric(value, family, checkout) {
  if (family === 'independent-recovery') verifyRecoveryMetrics(value);
  else if (family === 'application-recovery') verifyApplicationRecovery(value);
  else if (family === 'evidence-catalogue') catalogue(value);
  else refuse();
  const controls = { 'evidence-catalogue': 12, 'independent-recovery': 30, 'application-recovery': 13 }[family];
  if (value.format !== 1 || value.synthetic !== true || value.status !== 'passed' || value.runtime.gitHead !== checkout
    || value.runtime.node !== 'v22.22.0' || value.runtime.platform !== 'linux' || value.runtime.architecture !== 'x64'
    || !Array.isArray(value.controls) || value.controls.length !== controls || new Set(value.controls.map(c => c.name)).size !== controls) refuse();
  for (const control of value.controls) {
    exactKeys(control, ['name', 'passed']);
    if (control.passed !== true || !/^[a-z0-9-]{1,80}$/.test(control.name)) refuse();
  }
}
function validateTiming(value) {
  exactKeys(value, ['format', 'phase', 'libraries', 'durationMs', 'exitCode', 'nodeVersion']);
  if (value.format !== 1 || value.phase !== 'shared-library-build' || value.exitCode !== 0 || value.nodeVersion !== '22.22.0'
    || JSON.stringify(value.libraries) !== JSON.stringify(['shared-types', 'cpic-schema', 'fake-idp', 'jobs'])
    || !Number.isSafeInteger(value.durationMs) || value.durationMs < 0) refuse();
}
function validateCompletion(value, profile, budget) {
  exactKeys(value, ['format', 'profile', 'budget', 'startedMs', 'finishedMs', 'summary', 'hashes']);
  exactKeys(value.budget, Object.keys(budget));
  if (value.format !== 1 || value.profile !== profile || Object.keys(budget).some(k => value.budget[k] !== budget[k])
    || ![value.startedMs, value.finishedMs].every(Number.isSafeInteger) || value.startedMs < budget.startedMs
    || value.finishedMs < value.startedMs || value.finishedMs >= budget.deadlineMs) refuse();
  validateSummary(value.summary);
}

export async function runProducer(profile, script, { env = process.env, cwd = root, now = Date.now, execute = runScript } = {}) {
  if (!Object.hasOwn(logs, profile)) refuse();
  const budget = loadBudget(env, now());
  const startedMs = now();
  const target = join(temporary(env), profile === 'worker' ? 'service-worker' : `service-profile-${profile}`);
  if (!existsSync(target)) mkdirSync(target);
  if (!lstatSync(target).isDirectory()) refuse();
  // A second producer cannot reuse files from an earlier invocation in this job.
  if (readdirSync(target).length) refuse();
  const fence = profile === 'worker' ? null : metricFence(profile, cwd);
  const completion = join(target, 'completion.json');
  const log = join(cwd, logs[profile]);
  if (existsSync(log)) safeFile(log);
  writeFileSync(log, '', { mode: 0o600 });
  const status = await execute(script, budget, { env, cwd, now });
  if (status !== 0) return status;
  remainingMs(budget, now());
  const summary = parseSummary(readFileSync(log, 'utf8'), profile === 'worker');
  const hashes = {};
  if (profile !== 'worker') {
    for (const [index, name] of metricFiles(profile).entries()) {
      const file = join(cwd, 'apps/backend/test-results', name);
      const info = lstatSync(file, { bigint: true });
      if (!info.isFile() || info.dev !== fence.dev || info.mtimeNs < fence.mtimeNs) refuse();
      const value = readJson(file); validateMetric(value, families[index], budget.checkout);
      const bytes = readFileSync(file); writeFileSync(join(target, name), bytes, { mode: 0o600 }); hashes[name] = sha(bytes);
    }
    const file = join(temporary(env), 'service-test-prerequisites.json');
    if (lstatSync(file).mtimeMs < budget.startedMs) refuse();
    validateTiming(readJson(file));
    const bytes = readFileSync(file); writeFileSync(join(target, 'service-test-prerequisites.json'), bytes, { mode: 0o600 });
    hashes['service-test-prerequisites.json'] = sha(bytes);
  }
  const value = { format: 1, profile, budget, startedMs, finishedMs: now(), summary, hashes };
  validateCompletion(value, profile, budget);
  remainingMs(budget, now());
  writeJson(completion, value);
  return 0;
}

function bundles({ env, directory, now }) {
  validateNeeds(JSON.parse(env.SERVICE_NEEDS ?? 'null'));
  const budget = loadBudget(env, now());
  if (!lstatSync(directory).isDirectory()) refuse();
  const expected = Object.keys(profiles).map(p => `service-profile-${p}-${budget.attempt}`);
  if (JSON.stringify(readdirSync(directory).sort()) !== JSON.stringify(expected.sort())) refuse();
  const records = [];
  for (const profile of Object.keys(profiles)) {
    const bundle = join(directory, `service-profile-${profile}-${budget.attempt}`);
    if (!lstatSync(bundle).isDirectory()) refuse();
    const files = [...metricFiles(profile), 'service-test-prerequisites.json'];
    if (JSON.stringify(readdirSync(bundle).sort()) !== JSON.stringify([...files, 'completion.json'].sort())) refuse();
    const completion = readJson(join(bundle, 'completion.json'));
    validateCompletion(completion, profile, budget); exactKeys(completion.hashes, files);
    if (completion.finishedMs > now()) refuse();
    for (const name of files) {
      const file = join(bundle, name); safeFile(file);
      if (completion.hashes[name] !== sha(readFileSync(file))) refuse();
    }
    validateTiming(readJson(join(bundle, 'service-test-prerequisites.json')));
    for (const [index, name] of metricFiles(profile).entries()) {
      validateMetric(readJson(join(bundle, name)), families[index], budget.checkout);
      records.push([name, readFileSync(join(bundle, name))]);
    }
  }
  remainingMs(budget, now());
  return { budget, records };
}
export function collect({ env = process.env, directory = join(temporary(env), 'service-profiles'), cwd = root, now = Date.now } = {}) {
  const { budget, records } = bundles({ env, directory, now });
  // No existing result, cached file or overwrite can satisfy this collection boundary.
  const target = join(cwd, 'apps/backend/test-results'); mkdirSync(target, { recursive: true });
  for (const [name, bytes] of records) writeFileSync(join(target, name), bytes, { mode: 0o600, flag: 'wx' });
  verifyAllProfiles(target, budget.checkout); verifyApplicationProfiles(target, budget.checkout);
  remainingMs(budget, now());
}
export function finish({ env = process.env, cwd = root, now = Date.now } = {}) {
  validateNeeds(JSON.parse(env.SERVICE_NEEDS ?? 'null'));
  const budget = loadBudget(env, now());
  const { records } = bundles({ env, directory: join(temporary(env), 'service-profiles'), now });
  for (const [name, bytes] of records) {
    const result = join(cwd, 'apps/backend/test-results', name); safeFile(result);
    if (sha(readFileSync(result)) !== sha(bytes)) refuse();
  }
  const worker = readJson(join(temporary(env), 'service-worker/completion.json'));
  validateCompletion(worker, 'worker', budget); exactKeys(worker.hashes, []);
  if (worker.finishedMs > now()) refuse();
  verifyAllProfiles(join(cwd, 'apps/backend/test-results'), budget.checkout);
  verifyApplicationProfiles(join(cwd, 'apps/backend/test-results'), budget.checkout);
  remainingMs(budget, now());
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.versions.node !== '22.22.0') refuse();
    const [mode, profile, ...extra] = process.argv.slice(2);
    if (mode === 'run' && Object.hasOwn(logs, profile) && !extra.length) process.exitCode = await runProducer(profile, readFileSync(0, 'utf8'));
    else if (!profile && !extra.length && mode === 'dependencies') validateNeeds(JSON.parse(process.env.SERVICE_NEEDS ?? 'null'));
    else if (!profile && !extra.length && mode === 'collect') collect();
    else if (!profile && !extra.length && mode === 'finish') finish();
    else refuse();
  } catch { process.stderr.write('Service evidence command failed.\n'); process.exitCode = 1; }
}
