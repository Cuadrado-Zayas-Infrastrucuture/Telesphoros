// Which migrations a release onto running synthetic staging may apply (spec 027, PR 3b), for migrate.sh. The per-release copies named the
// pending list by hand, edited each release; here it is derived: the migrations at the release commit numbered after `newestMigration` in
// docs/ops/staging-expected.json on origin/main, which the docs pull request after each release keeps current. On a first run the pending list
// must be exactly that; only a run that already started migrate-up (an interrupted one) may find a tail of it, or nothing, left.
//   node migration-pending.mjs expected MIGRATIONS_DIR FACTS_JSON        prints the expected versions, space separated ("" for none)
//   node migration-pending.mjs check "EXPECTED" STATUS_FILE [resumed]    exit 0 when the pending line of `migrate status` is allowed
import { readdirSync, readFileSync } from 'node:fs';
import { isMain } from '../is-main.mjs';

const VERSION = /^[0-9]{4}$/;
const UP = /^([0-9]{4})_[a-z0-9_]+\.up\.sql$/;

/** The versions after `newest`, in order. Refuses when `newest` itself is not among the files: the facts file names another history. */
export function expectedPending(files, newest) {
  if (!VERSION.test(newest ?? '')) throw new Error(`newestMigration ${JSON.stringify(newest)} is not a four-digit version`);
  const versions = [...new Set(files.map((f) => UP.exec(f)?.[1]).filter(Boolean))].sort();
  if (!versions.includes(newest)) throw new Error(`newestMigration ${newest} is not a migration at this commit`);
  return versions.filter((v) => v > newest);
}

/** The versions on the last `pending:` line of `migrate status` output ([] for "(none)"). Refuses a missing or unreadable line. */
export function parsePending(text) {
  const lines = String(text).split(/[\t\n]/).map((l) => l.match(/pending: (.*)$/)?.[1]).filter((l) => l !== undefined);
  if (lines.length === 0) throw new Error('no "pending:" line in the migrate status output');
  const last = lines[lines.length - 1].trim();
  if (last === '(none)') return [];
  const versions = last.split(',').map((v) => v.trim());
  if (!versions.every((v) => VERSION.test(v))) throw new Error(`unreadable pending line: ${last}`);
  return versions;
}

/** Why `pending` is not what this release may apply; null when it is. */
export function pendingProblem(expected, pending, resumed) {
  const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
  if (same(expected, pending)) return null;
  const tail = expected.slice(expected.length - pending.length);
  if (resumed && same(tail, pending)) return null;
  const want = expected.join(' ') || '(none)';
  const got = pending.join(' ') || '(none)';
  return resumed
    ? `pending is ${got}, which is neither ${want} nor a tail of it`
    : `pending is ${got}, not exactly ${want} (the migrations after newestMigration in docs/ops/staging-expected.json on origin/main)`;
}

if (isMain(import.meta.url)) {
  const [cmd, a, b, c] = process.argv.slice(2);
  try {
    if (cmd === 'expected') {
      const newest = JSON.parse(readFileSync(b, 'utf8')).newestMigration;
      console.log(expectedPending(readdirSync(a), newest).join(' '));
    } else if (cmd === 'check') {
      const expected = a.split(' ').filter(Boolean);
      const pending = parsePending(readFileSync(b, 'utf8'));
      const problem = pendingProblem(expected, pending, c === 'resumed');
      console.log(`pending: ${pending.join(' ') || '(none)'}; expected: ${expected.join(' ') || '(none)'}`);
      if (problem) { console.error(problem); process.exit(1); }
    } else {
      throw new Error('usage: migration-pending.mjs expected MIGRATIONS_DIR FACTS_JSON | check "EXPECTED" STATUS_FILE [resumed]');
    }
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
}
