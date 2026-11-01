// What synthetic staging runs, against docs/ops/staging-expected.json (spec 027, PR 2). Pure: staging-status.sh does every read and hands
// this module what it saw. It prints field names, revisions, digests, counts, addresses and commit subjects; never a state value, a plan
// value or a variable. A refused or missing read is `unknown`, never `ok`, and any row that is not `ok` fails the run.
//
//   node staging-status.mjs project-state  < state.json      prints {"serial":N,"lineage":"..."}; nothing else of the state
//   node staging-status.mjs project-plan   < plan.json       prints "actions address" per change; no-ops and reads dropped
//   node staging-status.mjs collect WORKDIR                  prints, as JSON, what staging-status.sh left in its work directory
//   node staging-status.mjs report FACTS OBSERVED            prints the table; exits 0 only when there is nothing to do
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CLAIM_ABANDONED_HOURS = 24;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const readable = (v) => v !== undefined && v !== null && !(typeof v === 'object' && !Array.isArray(v) && 'refused' in v);

/** One row per checked field: the value the facts file expects, the value read, and ok / DRIFT / unknown. */
export function compare(facts, observed) {
  const o = observed ?? {};
  const paths = (v) => (Array.isArray(v) ? [...v].sort() : v);
  const fields = [
    ['api.revision', facts.taskDefinitions.api, o.api?.revision],
    ['api.digest', facts.image.digest, o.api?.digest],
    ['worker.revision', facts.taskDefinitions.worker, o.worker?.revision],
    ['worker.digest', facts.image.digest, o.worker?.digest],
    ['alarms', facts.alarms, o.alarms],
    ['cloudfrontCachePaths', paths(facts.cloudfrontCachePaths), paths(o.cloudfrontCachePaths)],
    ['newestMigration', facts.newestMigration, o.newestMigration],
    ['ready', 200, o.ready],
  ];
  return fields.map(([field, expected, live]) => ({
    field, expected, live,
    status: !readable(live) ? 'unknown' : same(expected, live) ? 'ok' : 'DRIFT',
  }));
}

/** The state's serial and lineage. Throws, naming no value, on anything that is not a state with both. */
export function stateIdentity(text) {
  let s;
  try { s = JSON.parse(text); } catch { throw new Error('the state is not JSON'); }
  if (!Number.isInteger(s?.serial) || typeof s?.lineage !== 'string' || !s.lineage) throw new Error('the state has no integer serial and lineage');
  return { serial: s.serial, lineage: s.lineage };
}

/** "actions address" for each change in a plan, sorted; no-ops and data reads dropped. Nothing of before, after or the variables. */
export function planSummary(plan) {
  if (!Array.isArray(plan?.resource_changes)) throw new Error('the plan has no resource_changes');
  return plan.resource_changes
    .filter((c) => !['no-op', 'read'].includes(c?.change?.actions?.join(',')))
    .map((c) => `${c.change.actions.join(',')} ${c.address}`)
    .sort();
}

const show = (v) => (v === undefined || v === null ? '-' : typeof v === 'object' ? (Array.isArray(v) ? v.join(' ') || '(none)' : 'refused') : String(v));

/**
 * The printed table and the exit code. Fails (1) on any row that is not ok, a plan that has changes or did not run, Terraform merged after
 * the applied commit, a saved plan made at another serial or with no record, or a claim older than CLAIM_ABANDONED_HOURS.
 */
export function report({ rows, plan, unapplied = [], savedPlans = [], legacyPlans = 0, claim = null, serial = null, now }) {
  const lines = [];
  const problems = [];
  const width = Math.max(...rows.map((r) => r.field.length));
  lines.push(`${'field'.padEnd(width)}  expected  live  status`);
  for (const r of rows) {
    lines.push(`${r.field.padEnd(width)}  ${show(r.expected)}  ${show(r.live)}  ${r.status}`);
    if (r.status !== 'ok') problems.push(r.field);
  }
  if (plan?.exit === 0) lines.push('plan: no changes (exit 0)');
  else if (plan?.exit === 2) { lines.push(`plan: ${plan.changes.length} change(s) (exit 2)`, ...plan.changes.map((c) => `  ${c}`)); problems.push('plan'); }
  else { lines.push(`plan: ${plan?.exit === 1 ? 'failed (exit 1)' : `not run${plan?.why ? `: ${plan.why}` : ''}`}`); problems.push('plan'); }
  lines.push(`state serial: ${serial ?? 'unknown'}`);
  if (serial === null) problems.push('serial');
  if (unapplied.length) { lines.push(`merged after the applied commit, under infrastructure/terraform/: ${unapplied.length}`, ...unapplied.map((u) => `  ${u}`)); problems.push('unapplied'); }
  else lines.push('merged after the applied commit, under infrastructure/terraform/: none');
  for (const p of savedPlans) {
    const fresh = p.serial !== null && p.serial === serial;
    lines.push(`saved plan ${p.path}: ${p.serial === null ? 'STALE (no record)' : fresh ? `current (serial ${p.serial})` : `STALE (serial ${p.serial})`}`);
    if (!fresh) problems.push(p.path);
  }
  if (legacyPlans) lines.push(`${legacyPlans} saved plans from before spec 027 are not checked; none of them may be applied`);
  if (claim) {
    const hours = (Date.parse(now) - Date.parse(claim.started)) / 3_600_000;
    const abandoned = !(hours < CLAIM_ABANDONED_HOURS);
    lines.push(`claim: held by ${claim.owner} for ${Number.isFinite(hours) ? hours.toFixed(1) : '?'} h (${claim.reason})${abandoned ? ' ABANDONED: ask its owner, never break it' : ''}`);
    if (abandoned) problems.push('claim');
  } else lines.push('claim: none');
  lines.push(problems.length ? `NOT CURRENT: ${problems.join(', ')}` : 'current: nothing to do');
  return { text: lines.join('\n'), exitCode: problems.length ? 1 : 0 };
}

/**
 * What staging-status.sh read, from its work directory, as the object report() takes. For a read named N the shell leaves N.out (the answer)
 * or N.refused (AWS's error code, possibly empty); a refusal becomes { refused }, an absent read stays undefined, and both are `unknown`.
 */
export function collect(dir, env, { exists, read, now = new Date().toISOString() }) {
  const file = (n) => (exists(`${dir}/${n}`) ? read(`${dir}/${n}`).trim() : null);
  const answer = (n, parse) => {
    const r = file(`${n}.refused`);
    if (r !== null) return { refused: r || 'refused' };
    const v = file(`${n}.out`);
    return v === null || v === '' ? undefined : parse(v);
  };
  const int = (v) => (/^\d+$/.test(v ?? '') ? Number(v) : undefined);
  const serialOf = (plan) => { try { return JSON.parse(read(`${plan}.meta.json`)).serial ?? null; } catch { return null; } };
  const lines = (n) => (file(n) ?? '').split('\n').filter(Boolean);
  let state = {};
  try { state = JSON.parse(file('state.json') || '{}'); } catch { state = {}; }
  const service = (s) => ({
    revision: file(`${s}-td.refused`) !== null ? { refused: file(`${s}-td.refused`) || 'refused' } : int(file(`${s}-revision`)),
    digest: file(`${s}-image.refused`) !== null ? { refused: file(`${s}-image.refused`) || 'refused' } : file(`${s}-digest`) || undefined,
  });
  return {
    api: service('api'),
    worker: service('worker'),
    alarms: answer('alarms', int),
    cloudfrontCachePaths: file('dists.refused') !== null ? { refused: file('dists.refused') || 'refused' } : answer('paths', (v) => (v === 'None' ? [] : v.split(/\s+/))),
    newestMigration: file('migration') || undefined,
    ready: int(env.READY),
    plan: { exit: env.PLAN_EXIT === 'null' ? null : Number(env.PLAN_EXIT), changes: lines('changes'), why: env.PLAN_WHY || undefined },
    unapplied: lines('unapplied'),
    savedPlans: lines('saved').map((f) => ({ path: f.startsWith(`${env.PRIVATE}/`) ? f.slice(env.PRIVATE.length + 1) : f, serial: serialOf(f) })),
    legacyPlans: Number(env.LEGACY ?? 0),
    claim: exists(env.CLAIM ?? '') ? JSON.parse(read(env.CLAIM)) : null,
    serial: Number.isInteger(state.serial) ? state.serial : null,
    now,
  };
}

const stdin = () => readFileSync(0, 'utf8');

function main([mode, factsPath, observedPath]) {
  if (mode === 'project-state') return console.log(JSON.stringify(stateIdentity(stdin())));
  if (mode === 'project-plan') {
    let plan;
    try { plan = JSON.parse(stdin()); } catch { throw new Error('the plan is not JSON'); }
    for (const line of planSummary(plan)) console.log(line);
    return;
  }
  if (mode === 'collect') {
    return console.log(JSON.stringify(collect(factsPath, process.env, { exists: existsSync, read: (f) => readFileSync(f, 'utf8') })));
  }
  if (mode === 'report') {
    const facts = JSON.parse(readFileSync(factsPath, 'utf8'));
    const observed = JSON.parse(readFileSync(observedPath, 'utf8'));
    const r = report({ ...observed, rows: compare(facts, observed) });
    console.log(r.text);
    process.exitCode = r.exitCode;
    return;
  }
  throw new Error('usage: staging-status.mjs project-state | project-plan | report FACTS OBSERVED');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(`staging-status: ${e.message}`); process.exitCode = 2; }
}
