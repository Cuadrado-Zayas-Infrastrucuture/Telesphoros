#!/usr/bin/env bash
# Runs the backend tests as the public repository will see them: with the imported report-reader engine (knowledge/lab-report-reader) and its
# Python sidecar (sidecars/report-reader) removed. The two directories are RENAMED in place (same filesystem, so a rename cannot be left
# half done) and put back on exit, on Ctrl-C and on error; those two directories must have no uncommitted changes first, so the restore can be proven.
#
#   scripts/check-without-reader.sh                 run the backend suite without the engine; it must pass (the engine specs are skipped, and said so)
#   scripts/check-without-reader.sh --measure       run it WITHOUT skipping anything, find the spec files that fail, and compare them with
#                                                   apps/backend/test/helpers/reader-engine-specs.json (exit 1 if they differ)
#   scripts/check-without-reader.sh --measure --write   the same, then rewrite that list from the measurement
#
# The database and object-storage tiers run when TEST_DATABASE_URL / TEST_S3_ENDPOINT (and TEST_STORAGE / TEST_OBJECT_STORAGE) are set, exactly as for `pnpm test`.
# Do not edit files while it runs: the engine is absent from the tree until it finishes.
set -uo pipefail

measure=0; write=0
for arg in "$@"; do
  case "$arg" in
    --measure) measure=1 ;;
    --write) write=1 ;;
    *) echo "usage: $0 [--measure [--write]]" >&2; exit 2 ;;
  esac
done
[ "$write" = 1 ] && [ "$measure" = 0 ] && { echo "--write needs --measure" >&2; exit 2; }

root="$(git rev-parse --show-toplevel)" || exit 1
cd "$root" || exit 1
dirs=(knowledge/lab-report-reader sidecars/report-reader)

[ -z "$(git status --porcelain -- "${dirs[@]}")" ] || { echo "${dirs[*]} have uncommitted changes; commit or discard them first, so the restore can be checked." >&2; exit 1; }
for d in "${dirs[@]}"; do
  [ -d "$d" ] || { echo "$d is not here already; nothing to remove. (This checkout is already without the engine: run: pnpm --filter backend test)" >&2; exit 1; }
  [ ! -e "$d.hidden" ] || { echo "$d.hidden exists from an interrupted run; move it back to $d by hand first." >&2; exit 1; }
done

restore() {
  for d in "${dirs[@]}"; do [ -d "$d.hidden" ] && mv "$d.hidden" "$d"; done
  if [ -n "$(git status --porcelain -- "${dirs[@]}")" ]; then echo "WARNING: ${dirs[*]} differ from the commit after restoring:" >&2; git status --short -- "${dirs[@]}" | head >&2; fi
}
trap restore EXIT
trap 'exit 130' INT TERM

for d in "${dirs[@]}"; do mv "$d" "$d.hidden" || exit 1; done

if [ "$measure" = 0 ]; then
  (cd apps/backend && pnpm exec jest)
  exit $?
fi

out="$(mktemp -t reader-measure.XXXXXX)" || exit 1
(cd apps/backend && READER_ENGINE=measure pnpm exec jest --json --outputFile="$out" >/dev/null 2>&1)
node - "$out" "$write" <<'NODE'
const fs = require('node:fs'), path = require('node:path');
const [, , outFile, write] = process.argv;
const listFile = path.resolve('apps/backend/test/helpers/reader-engine-specs.json');
const result = JSON.parse(fs.readFileSync(outFile, 'utf8'));
const failing = new Map();
for (const suite of result.testResults) {
  if (suite.status !== 'failed') continue;
  const spec = path.relative(path.resolve('apps/backend'), suite.name);
  const failed = suite.assertionResults.filter((a) => a.status === 'failed').length;
  failing.set(spec, { failed, total: suite.assertionResults.length });
}
const specs = [...failing.keys()].sort();
const partialSkip = {};
for (const [spec, { failed, total }] of failing) if (total > 0 && failed < total) partialSkip[spec] = `${total - failed} of ${total} tests do not need the engine`;
const current = JSON.parse(fs.readFileSync(listFile, 'utf8'));
const missing = specs.filter((s) => !current.specs.includes(s)), stale = current.specs.filter((s) => !specs.includes(s));
console.log(`${specs.length} spec files fail without the engine (${result.numFailedTests} of ${result.numTotalTests} tests).`);
if (write === '1') {
  fs.writeFileSync(listFile, JSON.stringify({ note: current.note, specs, partialSkip }, null, 2) + '\n');
  console.log(`Rewrote ${path.relative(process.cwd(), listFile)}.`);
} else if (missing.length || stale.length) {
  if (missing.length) console.error('Fail without the engine but are not on the list:\n  ' + missing.join('\n  '));
  if (stale.length) console.error('On the list but pass without the engine:\n  ' + stale.join('\n  '));
  process.exit(1);
} else console.log('The list in reader-engine-specs.json matches the measurement.');
NODE
status=$?
rm -f "$out"
exit $status
