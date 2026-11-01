// The record a release keeps next to each saved plan (spec 027, PR 3a): which state, which clone HEAD and which var file it was made from.
// An apply refuses a plan whose record does not match the stack now, before Terraform's own stale-plan refusal; staging-status.sh reads the
// serial to mark other saved plans stale. Nothing of the state is kept but its serial and lineage.
//   node plan-record.mjs state < state.json                       prints {"serial":N,"lineage":"..."}
//   node plan-record.mjs write META MODE HEAD VAR_SHA PLAN_SHA < state-identity.json
//   node plan-record.mjs check META MODE HEAD VAR_SHA PLAN_SHA < state-identity.json   exits 1 naming each mismatch
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HEX64 = /^[0-9a-f]{64}$/;

/** The state's serial and lineage. Throws, naming no value, on anything that is not a state with both. */
export function stateIdentity(text) {
  let s;
  try { s = JSON.parse(text); } catch { throw new Error('the state is not JSON'); }
  if (!Number.isInteger(s?.serial) || typeof s?.lineage !== 'string' || !s.lineage) throw new Error('the state has no integer serial and lineage');
  return { serial: s.serial, lineage: s.lineage };
}

export function record({ mode, head, varSha256, planSha256, state, made = new Date().toISOString() }) {
  if (!['MIGRATE', 'IMAGE', 'INFRA'].includes(mode)) throw new Error('mode must be MIGRATE, IMAGE or INFRA');
  if (!/^[0-9a-f]{40}$/.test(head ?? '')) throw new Error('head is not a full commit id');
  if (!HEX64.test(varSha256 ?? '') || !HEX64.test(planSha256 ?? '')) throw new Error('the var file and plan hashes must be sha256 hex');
  return { mode, serial: state.serial, lineage: state.lineage, head, varSha256, planSha256, made };
}

/** Each way the stack now differs from the record, as text; empty when the plan is still the one that was read. */
export function mismatches(saved, now) {
  return ['mode', 'serial', 'lineage', 'head', 'varSha256', 'planSha256']
    .filter((k) => saved?.[k] !== now[k])
    .map((k) => `${k}: the plan was made at ${saved?.[k] ?? '(none)'}, now ${now[k]}`);
}

function main([cmd, meta, mode, head, varSha256, planSha256]) {
  const input = readFileSync(0, 'utf8');
  if (cmd === 'state') return console.log(JSON.stringify(stateIdentity(input)));
  const state = JSON.parse(input);
  const now = record({ mode, head, varSha256, planSha256, state });
  if (cmd === 'write') return writeFileSync(meta, `${JSON.stringify(now, null, 2)}\n`, { mode: 0o600 });
  if (cmd === 'check') {
    let saved;
    try { saved = JSON.parse(readFileSync(meta, 'utf8')); } catch { saved = null; }
    const found = saved ? mismatches(saved, now) : ['no record next to the plan: it was not made by this recipe'];
    for (const m of found) console.error(`STALE: ${m}`);
    process.exitCode = found.length ? 1 : 0;
    return;
  }
  throw new Error('usage: plan-record.mjs state | write META ... | check META ...');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(`plan-record: ${e.message}`); process.exitCode = 2; }
}
