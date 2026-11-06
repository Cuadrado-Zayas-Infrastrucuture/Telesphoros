#!/usr/bin/env bash
# The migration step of a release onto running synthetic staging (spec 027, PR 3b), after the MIGRATE apply and before the IMAGE plan.
# Founder-run, under the claim. Changes the schema.
#   CLAIM_OWNER=NAME scripts/staging/release/migrate.sh MIGRATE COMMIT
# MIGRATE confirms that nobody is using staging: between migrate-up and the IMAGE apply the old API and worker run on the new schema, and an
# idle window keeps writes out of that gap. Order: gates -> migrate status, which must show exactly the migrations at COMMIT after
# `newestMigration` in docs/ops/staging-expected.json on origin/main (migration-pending.mjs) -> the idle window (no write request to the API
# in 30 minutes, with its GETs as the positive control) -> an RDS snapshot, waited for -> migrate-up -> migrate status, which must say
# `pending: (none)` (saved as migrate-status.txt, which the IMAGE and assessment steps read). With nothing to migrate it records that and
# takes no snapshot. A rerun after an interrupted migrate-up may find only the tail of the list pending.
set -euo pipefail
umask 077
# shellcheck source=scripts/staging/release/lib.sh
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"
[ "${1:-}" = MIGRATE ] || die "usage: migrate.sh MIGRATE COMMIT (MIGRATE confirms that nobody is using staging)"
COMMIT="${2:-}"
release_folder "$COMMIT"
load_stack
[ -d "$OUT" ] || die "no $OUT: the image step has not run"
[ ! -e "$OUT/migrate-status.txt" ] || die "migrate-status.txt exists: the migration already finished; tell Claude"
step_lock migrate
exec > >(tee -a "$OUT/migrate.log") 2>&1
echo "release migrate ${COMMIT:0:8} started $(date -u +%H:%M:%SZ)"

echo "== 1. Gates"
claim_check
gate_node
gate_quiet
gate_identity
gate_clone "$COMMIT"
grep -qx '== apply exit status: 0' "$OUT/m-apply.txt" 2>/dev/null || die "the MIGRATE apply of this release did not finish with exit 0"
NEW=$(cat "$OUT/new_image.txt") || die "no new_image.txt"
export ECS_CLUSTER MIGRATE_TASK_FAMILY PROVISION_TASK_FAMILY TASK_SUBNETS TASK_SECURITY_GROUP TASK_ASSIGN_PUBLIC_IP API_LOG_GROUP
ECS_CLUSTER=$(tf_out api_cluster_name); MIGRATE_TASK_FAMILY=$(tf_out api_migrate_task_family); PROVISION_TASK_FAMILY=$(tf_out api_provision_task_family)
TASK_SECURITY_GROUP=$(tf_out api_tasks_security_group_id); TASK_ASSIGN_PUBLIC_IP=$(tf_out api_task_assign_public_ip); API_LOG_GROUP=$(tf_out api_log_group)
TASK_SUBNETS=$("$TERRAFORM" -chdir="$TFDIR" output -json api_task_subnet_ids </dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).join(",")))')
[ -n "$ECS_CLUSTER" ] && [ -n "$MIGRATE_TASK_FAMILY" ] && [ -n "$API_LOG_GROUP" ] && [ -n "$TASK_SUBNETS" ] || die "a Terraform output is empty"
DB=$(tf_out db_endpoint); DB=${DB%%.*}
[[ "$DB" =~ ^[a-z][a-z0-9-]{0,62}$ ]] || die "cannot read the database identifier from db_endpoint"
SNAP="$DB-pre-${COMMIT:0:8}"
MIMG=$(aws ecs describe-task-definition --task-definition "$MIGRATE_TASK_FAMILY" --query 'taskDefinition.containerDefinitions[0].image' --output text </dev/null) || die "cannot read the migrate task definition"
[ "$MIMG" = "$NEW" ] || die "the migrate task definition runs ${MIMG##*@}, not the NEW image"
for S in telesphoros-staging-api telesphoros-staging-worker; do
  SVC=$(aws ecs describe-services --cluster "$ECS_CLUSTER" --services "$S" --query 'services[0].[length(deployments),deployments[0].rolloutState,runningCount,desiredCount]' --output text </dev/null) || die "cannot read $S"
  read -r NDEP ROLL RUN DES <<<"$SVC"
  [ "$NDEP" = 1 ] && [ "$ROLL" = COMPLETED ] && [ "$RUN" = "$DES" ] || die "$S is not steady (deployments $NDEP, rollout $ROLL, running $RUN of $DES)"
done
git -C "$C" show origin/main:docs/ops/staging-expected.json > "$OUT/facts-at-migrate.json" || die "no docs/ops/staging-expected.json on origin/main"
EXPECTED=$(node "$HERE/migration-pending.mjs" expected "$C/apps/backend/migrations" "$OUT/facts-at-migrate.json") || die "cannot derive the expected migrations (above)"
RESUMED=""; [ -e "$OUT/migrate-up.started" ] && RESUMED=resumed
echo "expected pending: ${EXPECTED:-(none)}${RESUMED:+ (a migrate-up already started for this release)}"
echo ok

echo "== 2. migrate status before"
cd "$C"
scripts/staging/run-task.sh migrate-status --yes </dev/null > "$OUT/migrate-status-before.txt" 2>&1 || { cat "$OUT/migrate-status-before.txt"; die "migrate-status failed"; }
PENDING=$(node "$HERE/migration-pending.mjs" check "$EXPECTED" "$OUT/migrate-status-before.txt" ${RESUMED:+"$RESUMED"}) || die "nothing migrated; tell Claude"
echo "$PENDING"
if [ "${PENDING%%;*}" = "pending: (none)" ]; then
  printf 'pending: (none)\n' > "$OUT/migrate-status.txt"
  echo "Nothing to migrate: migrate-status.txt says pending: (none). Next: plan.sh IMAGE $COMMIT"
  exit 0
fi

echo "== 3. Idle window: write requests to the API in the last 30 minutes"
START=$(( ($(date +%s) - 1800) * 1000 ))
count_events() { # filter pattern -> the count, then one line per method, route and status
  aws logs filter-log-events --log-group-name "$API_LOG_GROUP" --start-time "$START" --filter-pattern "$1" --query 'events[].message' --output json </dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const m=JSON.parse(s||"[]");const r={};for(const x of m){let j={};try{j=JSON.parse(x)}catch{}const k=[j.req&&j.req.method,j.route,j.res&&j.res.statusCode].join(" ");r[k]=(r[k]||0)+1}console.log(m.length);for(const[k,v]of Object.entries(r))console.log("   "+v+"  "+k)})'
}
GETS=$(count_events '{ $.req.method = "GET" }') || die "cannot read the API log group"
WRITES=$(count_events '{ ($.req.method = "POST") || ($.req.method = "PUT") || ($.req.method = "PATCH") || ($.req.method = "DELETE") }') || die "cannot read the API log group"
echo "GET requests (positive control: the health checks): ${GETS%%$'\n'*}"
echo "write requests: ${WRITES%%$'\n'*}"; [ "$WRITES" = "${WRITES%%$'\n'*}" ] || printf '%s\n' "${WRITES#*$'\n'}"
[ "${GETS%%$'\n'*}" -gt 0 ] || die "no GET request logged in 30 minutes: the API's request log cannot be read, so idleness is unproven; tell Claude"
[ "${WRITES%%$'\n'*}" = 0 ] || die "staging is not idle (write requests above): wait until nobody is using it, then rerun"

echo "== 4. RDS snapshot $SNAP (the recovery marker; restoring makes a NEW instance and loses later writes)"
SST=$(aws rds describe-db-snapshots --db-snapshot-identifier "$SNAP" --query 'DBSnapshots[0].Status' --output text </dev/null 2>/dev/null || echo NONE)
if [ "$SST" = NONE ]; then
  aws rds create-db-snapshot --db-instance-identifier "$DB" --db-snapshot-identifier "$SNAP" --query 'DBSnapshot.Status' --output text </dev/null || die "create-db-snapshot failed"
fi
aws rds wait db-snapshot-available --db-snapshot-identifier "$SNAP" </dev/null || die "the snapshot did not become available"
aws rds describe-db-snapshots --db-snapshot-identifier "$SNAP" --query 'DBSnapshots[0].[Status,SnapshotCreateTime]' --output text </dev/null

echo "== 5. migrate-up $(date -u +%H:%M:%SZ)"
date -u +%Y-%m-%dT%H:%M:%SZ > "$OUT/migrate-up.started"
scripts/staging/run-task.sh migrate-up --yes </dev/null || die "migrate-up failed: tell Claude (do not rerun before Claude reads the log)"

echo "== 6. migrate status after"
scripts/staging/run-task.sh migrate-status --yes </dev/null > "$OUT/migrate-status-after.txt" 2>&1 || { cat "$OUT/migrate-status-after.txt"; die "migrate-status failed after migrating; tell Claude"; }
node "$HERE/migration-pending.mjs" check "" "$OUT/migrate-status-after.txt" || die "migrations still pending: tell Claude"
printf 'pending: (none)\n' > "$OUT/migrate-status.txt"
echo "Done $(date -u +%H:%M:%SZ). Next: plan.sh IMAGE $COMMIT"
