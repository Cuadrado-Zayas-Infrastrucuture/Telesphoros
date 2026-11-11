#!/usr/bin/env bash
# Keeps the newest 3 pre-migration snapshots of the staging database and deletes older ones (founder decision OB5, 2026-11-11,
# docs/design/plans/observability-and-backups.md). Founder-run, synthetic staging only. A dry run unless --yes is given.
#   scripts/staging/release/prune-snapshots.sh DB_IDENTIFIER [--yes]
# migrate.sh runs it with --yes after a migration has finished and its new snapshot is available.
# What it touches: only MANUAL snapshots of DB_IDENTIFIER named DB_IDENTIFIER-pre-<8 hex>, the names migrate.sh gives. Automated backups
# and any other manual snapshot are never listed for deletion. It deletes nothing when any of those snapshots is not `available` (one still
# being created has no settled time to sort by), and never leaves fewer than 3.
set -euo pipefail
umask 077
# shellcheck source=scripts/staging/release/lib.sh
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"
KEEP=3
DB="${1:-}"
[[ "$DB" =~ ^[a-z][a-z0-9-]{0,62}$ ]] || die "usage: prune-snapshots.sh DB_IDENTIFIER [--yes]"
case "${2:-}" in --yes) YES=1 ;; '') YES="" ;; *) die "usage: prune-snapshots.sh DB_IDENTIFIER [--yes]" ;; esac
load_stack
gate_identity

LIST=$(aws rds describe-db-snapshots --db-instance-identifier "$DB" --snapshot-type manual \
  --query 'DBSnapshots[].[DBSnapshotIdentifier,Status,SnapshotCreateTime]' --output text </dev/null) || die "cannot list the snapshots of $DB"
# Prints "keep ID" and "delete ID" lines, newest first; exits 3 when a pre-migration snapshot is not available.
PLAN=$(printf '%s\n' "$LIST" | node -e '
  const [db, keep] = [process.argv[1], Number(process.argv[2])];
  const name = new RegExp(`^${db.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-pre-[0-9a-f]{8}$`);
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const rows = s.split("\n").map((l) => l.split("\t")).filter((r) => r.length === 3 && name.test(r[0]));
    const unsettled = rows.filter((r) => r[1] !== "available");
    if (unsettled.length) { for (const r of unsettled) console.log(`not available: ${r[0]} (${r[1]})`); process.exit(3); }
    rows.sort((a, b) => (a[2] < b[2] ? 1 : a[2] > b[2] ? -1 : 0));
    rows.forEach((r, i) => console.log(`${i < keep ? "keep" : "delete"} ${r[0]} ${r[2]}`));
  });' "$DB" "$KEEP") || { printf '%s\n' "$PLAN"; echo "A pre-migration snapshot is not available yet: nothing deleted. Rerun once it is."; exit 0; }

printf '%s\n' "${PLAN:-no pre-migration snapshots of $DB}"
DELETE=$(printf '%s\n' "$PLAN" | awk '$1 == "delete" { print $2 }')
if [ -z "$DELETE" ]; then echo "Nothing to delete: $KEEP or fewer pre-migration snapshots."; exit 0; fi
if [ -z "$YES" ]; then echo "Dry run: nothing deleted. Rerun with --yes to delete the snapshots marked delete."; exit 0; fi
for S in $DELETE; do
  aws rds delete-db-snapshot --db-snapshot-identifier "$S" --query 'DBSnapshot.Status' --output text </dev/null || die "delete-db-snapshot $S failed"
done
echo "Deleted $(printf '%s\n' "$DELETE" | wc -l | tr -d ' ') older pre-migration snapshot(s); kept the newest $KEEP."
