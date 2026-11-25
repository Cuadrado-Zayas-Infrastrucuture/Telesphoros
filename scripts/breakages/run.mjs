#!/usr/bin/env node
// Deliberate breakages, one at a time (docs/verification/breakages.md). Run ONLY inside a sealed OpenSandbox job (docs/ops/agent-policy.md),
// never on the host: it edits source files and runs tests.
//
//   node scripts/breakages/run.mjs --list
//   node scripts/breakages/run.mjs                         every entry whose tier the job can run (not "browser")
//   node scripts/breakages/run.mjs --tier backend-postgres  only these tiers (comma-separated); run `tele-services` first for postgres
//   node scripts/breakages/run.mjs --id W1-1,H2-3           only these entries
//   node scripts/breakages/run.mjs --no-control             skip the control runs (not recommended)
//
// For each entry: the file must contain `find` exactly once; the runner writes `replace` in its place, runs `command`, and puts the file back
// as it was, whatever happens. Before the first breakage of each command, it runs that command once unbroken (the control): a breakage only
// counts as caught when its control was green. Results go to scripts/breakages/results.json and a table on stdout.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const catalogue = JSON.parse(readFileSync(resolve(here, 'catalogue.json'), 'utf8'));
const TIMEOUT_MS = 12 * 60 * 1000;

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? null : (args[index + 1] ?? '');
};
const ids = option('--id')?.split(',').filter(Boolean) ?? null;
const tiers = option('--tier')?.split(',').filter(Boolean) ?? null;
const control = !args.includes('--no-control');

if (args.includes('--list')) {
  for (const entry of catalogue) console.log(`${entry.id.padEnd(9)} ${entry.tier.padEnd(17)} ${entry.rule}`);
  process.exit(0);
}

const chosen = catalogue.filter((entry) => (ids ? ids.includes(entry.id) : tiers ? tiers.includes(entry.tier) : entry.tier !== 'browser'));
if (chosen.length === 0) {
  console.error('No entry matches.');
  process.exit(2);
}

function run(command) {
  const started = Date.now();
  const result = spawnSync('bash', ['-c', command], { cwd: root, encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}`, seconds: Math.round((Date.now() - started) / 1000) };
}

const controls = new Map();
const results = [];
for (const entry of chosen) {
  const path = resolve(root, entry.file);
  let original;
  try {
    original = readFileSync(path, 'utf8');
  } catch {
    results.push({ id: entry.id, outcome: 'file-missing' });
    continue;
  }
  const count = original.split(entry.find).length - 1;
  if (count !== 1) {
    results.push({ id: entry.id, outcome: `find-matches-${count}` });
    continue;
  }
  if (control && !controls.has(entry.command)) {
    const unbroken = run(entry.command);
    controls.set(entry.command, unbroken.status === 0);
    console.error(`control ${unbroken.status === 0 ? 'green' : 'RED'} (${unbroken.seconds}s): ${entry.command}`);
  }
  if (control && !controls.get(entry.command)) {
    results.push({ id: entry.id, outcome: 'control-red' });
    continue;
  }
  let broken;
  try {
    writeFileSync(path, original.replace(entry.find, entry.replace));
    broken = run(entry.command);
  } finally {
    writeFileSync(path, original);
  }
  if (readFileSync(path, 'utf8') !== original) throw new Error(`${entry.file} was not restored; stop and check the tree`);
  // Caught: the command failed and its output names the guarding test. Red elsewhere: it failed, but not (visibly) on that test.
  const outcome = broken.status === 0 ? 'SURVIVED' : broken.output.includes(entry.expectRed) ? 'caught' : 'red-elsewhere';
  results.push({ id: entry.id, outcome, seconds: broken.seconds, tail: outcome === 'caught' ? undefined : broken.output.slice(-2000) });
  console.error(`${entry.id}: ${outcome} (${broken.seconds}s)`);
}

writeFileSync(resolve(here, 'results.json'), `${JSON.stringify({ ranAt: new Date().toISOString(), results }, null, 2)}\n`);
console.log('| Breakage | Tier | Rule | Outcome |\n| --- | --- | --- | --- |');
for (const result of results) {
  const entry = catalogue.find((item) => item.id === result.id);
  console.log(`| ${result.id} | ${entry.tier} | ${entry.rule} | ${result.outcome} |`);
}
process.exit(results.every((result) => result.outcome === 'caught') ? 0 : 1);
