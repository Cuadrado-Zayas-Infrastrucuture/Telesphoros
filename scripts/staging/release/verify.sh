#!/usr/bin/env bash
# Read-only checks after an apply of a release onto running synthetic staging (spec 027, PR 3b). Founder-run. Writes nothing in AWS; safe to
# run again (each run appends to the folder's verify.log). Needs API_BASE_URL in stack.env.
#   scripts/staging/release/verify.sh IMAGE COMMIT
#   scripts/staging/release/verify.sh ASSESSMENT-ON|ASSESSMENT-OFF|FENCE-CLOSE COMMIT OPERATION_ID
# The apply it follows must have exited 0, and its var file must still be current.tfvars: what is expected comes from that file, not from the
# running task. Checks: both services steady with every running task on the image current.tfvars names; /ready and /health; no alarm in
# ALARM; a ledger full check since the plan; the medication-fence observation judged by check-medication-fence-rollout.mjs (writes closed);
# and the synthetic assessment settings present exactly when current.tfvars switches it on. Writes verify-ok.txt next to the apply only when
# every check passes, with the current.tfvars sha256 it verified (frontend.sh publishes only on that). A `hold` with task-not-stable or
# deployment-not-complete right after an apply means "run it again in five minutes": old tasks can still be stopping.
set -uo pipefail
umask 077
# shellcheck source=scripts/staging/release/lib.sh
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"
MODE="${1:-}"; COMMIT="${2:-}"; OPERATION="${3:-}"
case "$MODE" in
  IMAGE) T=i ;; ASSESSMENT-ON) T=ae ;; ASSESSMENT-OFF) T=ad ;; FENCE-CLOSE) T="fc" ;;
  FENCE-OPEN) die "verify.sh checks a closed medication fence only (check-medication-fence-rollout.mjs): tell Claude" ;;
  *) die "usage: verify.sh IMAGE COMMIT, or verify.sh ASSESSMENT-ON|ASSESSMENT-OFF|FENCE-CLOSE COMMIT OPERATION_ID" ;;
esac
release_folder "$COMMIT" || exit 1
load_stack || exit 1
[[ "${API_BASE_URL:-}" =~ ^https://[a-z0-9.-]+$ ]] || die "API_BASE_URL in stack.env is not https://<host> without a path"
RELEASE_OUT="$OUT"
if [ "$MODE" = IMAGE ]; then
  [ -z "$OPERATION" ] || die "IMAGE takes no operation id"
  VARFILE="$OUT/release.tfvars"
else
  [[ "$OPERATION" =~ ^[a-z0-9][a-z0-9-]{0,47}$ ]] || die "the operation id must be 1-48 lower-case letters, digits or hyphens"
  OUT="$OUT/$(flag_folder "$MODE")/$OPERATION"
  VARFILE="$OUT/$T.tfvars"
fi
[ -d "$OUT" ] || die "no $OUT"
exec > >(tee -a "$OUT/verify.log") 2>&1
echo "release verify $MODE ${COMMIT:0:8}${OPERATION:+ $OPERATION} started $(date -u +%Y-%m-%dT%H:%M:%SZ)"
gate_identity
grep -qx '== apply exit status: 0' "$OUT/$T-apply.txt" 2>/dev/null || die "the $MODE apply has not finished with exit 0 ($T-apply.txt)"
[ -f "$VARFILE" ] && [ "$(sha "$VARFILE")" = "$(sha "$CURRENT")" ] || die "current.tfvars is not this apply's var file: a later apply changed it; verify that one"
CURSHA=$(sha "$CURRENT")
NEW=$(running_image) || exit 1
if [ "$MODE" = IMAGE ]; then [ "$NEW" = "$(cat "$RELEASE_OUT/new_image.txt" 2>/dev/null)" ] || die "current.tfvars does not name this release's new image"; fi
grep -Eq '^medication_writes_enabled[[:space:]]*=[[:space:]]*true' "$CURRENT" && die "current.tfvars opens medication writes: verify.sh checks a closed fence only; tell Claude"
WANTSET=absent; grep -Eq '^synthetic_assessment_enabled[[:space:]]*=[[:space:]]*true' "$CURRENT" && WANTSET=present
CL=$(tf_out api_cluster_name) || die "cannot read api_cluster_name"
SINCE="$OUT/$T.tfplan"
[ -f "$SINCE" ] || die "no $SINCE"
FAIL=0
fail() { echo "FAIL: $*"; FAIL=1; }

echo "== 1. ECS: steady services, every running task on ${NEW##*@}"
for S in telesphoros-staging-api telesphoros-staging-worker; do
  SVC=$(aws ecs describe-services --cluster "$CL" --services "$S" --query 'services[0].[serviceName,length(deployments),deployments[0].rolloutState,runningCount,desiredCount]' --output text </dev/null) || { fail "cannot read $S"; continue; }
  echo "   $SVC"
  read -r _ NDEP ROLL RUN DES <<<"$SVC"
  [ "$NDEP" = 1 ] && [ "$ROLL" = COMPLETED ] && [ "$RUN" = "$DES" ] && [ "$RUN" -gt 0 ] || fail "$S is not steady"
  for TASK in $(aws ecs list-tasks --cluster "$CL" --service-name "$S" --desired-status RUNNING --query 'taskArns[]' --output text </dev/null); do
    TD=$(aws ecs describe-tasks --cluster "$CL" --tasks "$TASK" --query 'tasks[0].taskDefinitionArn' --output text </dev/null)
    IMG=$(aws ecs describe-task-definition --task-definition "$TD" --query 'taskDefinition.containerDefinitions[0].image' --output text </dev/null)
    if [ "$IMG" = "$NEW" ]; then echo "   task ${TASK##*/}: ${TD##*/} on the expected image"; else fail "task ${TASK##*/}: ${TD##*/} runs ${IMG##*@}, not ${NEW##*@}"; fi
  done
done

echo "== 2. Endpoints"
for E in ready health; do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$API_BASE_URL/api/v1/$E" </dev/null)
  echo "   /api/v1/$E: $CODE"; [ "$CODE" = 200 ] || fail "/api/v1/$E returned $CODE"
done

echo "== 3. Alarms"
INALARM=$(aws cloudwatch describe-alarms --state-value ALARM --query 'MetricAlarms[].AlarmName' --output text </dev/null) || fail "cannot read the alarms"
if [ -z "$INALARM" ]; then echo "   none in ALARM"; else fail "in ALARM: $INALARM"; fi
WANTALARMS=$(git -C "$C" show origin/main:docs/ops/staging-expected.json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).alarms)}catch{console.log("unknown")}})')
echo "   telesphoros-staging alarms: $(aws cloudwatch describe-alarms --alarm-name-prefix telesphoros-staging --query 'length(MetricAlarms)' --output text </dev/null) (staging-expected.json on origin/main: $WANTALARMS)"

echo "== 4. Ledger full check since the $MODE plan (API log group, counts only)"
API_LOG_GROUP=$(tf_out api_log_group) || fail "cannot read api_log_group"
START=$(( ($(stat -f %m "$SINCE") - 60) * 1000 ))
LEDGER=$(aws logs filter-log-events --log-group-name "$API_LOG_GROUP" --start-time "$START" --filter-pattern '{ $.event = "ledger-full-check-completed" }' \
  --query 'events[].message' --output json </dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const m=JSON.parse(s||"[]").map(x=>{try{return JSON.parse(x)}catch{return {}}});console.log(m.length+" run(s); tenantsChecked: "+m.map(x=>x.tenantsChecked).join(","))})')
echo "   $LEDGER"
case "$LEDGER" in 0\ run*|"") fail "no ledger-full-check-completed line since the $MODE plan yet (the check runs after start; rerun in a few minutes)" ;; esac

echo "== 5. Medication fence observation (offline checker over a fresh, complete ECS packet)"
TD_ARN=$("$TERRAFORM" -chdir="$TFDIR" state show -no-color 'aws_ecs_task_definition.api[0]' </dev/null 2>/dev/null | sed -nE 's/^[[:space:]]*arn[[:space:]]*=[[:space:]]*"([^"]+)"$/\1/p')
[[ "$TD_ARN" =~ ^arn:aws:ecs:[a-z0-9-]+:[0-9]{12}:task-definition/telesphoros-staging-api:[0-9]+$ ]] || fail "cannot read the API task definition ARN from the Terraform state"
PK="$OUT/fence-observation"
mkdir -p "$PK"
aws ecs describe-services --cluster "$CL" --services telesphoros-staging-api --output json </dev/null > "$PK/services.json" || fail "describe-services"
aws ecs list-tasks --cluster "$CL" --service-name telesphoros-staging-api --desired-status RUNNING --output json </dev/null > "$PK/running.json" || fail "list-tasks RUNNING"
aws ecs list-tasks --cluster "$CL" --service-name telesphoros-staging-api --desired-status STOPPED --output json </dev/null > "$PK/stopped.json" || fail "list-tasks STOPPED"
ALL=$(node -e 'const f=require("fs");const a=[...JSON.parse(f.readFileSync(process.argv[1])).taskArns,...JSON.parse(f.readFileSync(process.argv[2])).taskArns];if(a.length>100)process.exit(3);console.log(a.join(" "))' "$PK/running.json" "$PK/stopped.json") || fail "more than 100 tasks to describe: tell Claude"
# shellcheck disable=SC2086 # ALL is a space-separated list of task ARNs, split on purpose
aws ecs describe-tasks --cluster "$CL" --tasks $ALL --output json </dev/null > "$PK/tasks.json" || fail "describe-tasks"
aws ecs describe-task-definition --task-definition "$TD_ARN" --output json </dev/null > "$PK/taskdef.json" || fail "describe-task-definition"
# shellcheck disable=SC2016 # the ${...} are JavaScript template literals inside node -e, not shell expansions
node -e '
const f = require("fs"); const r = (n) => JSON.parse(f.readFileSync(process.argv[1] + "/" + n, "utf8"));
const packet = { capturedAt: new Date().toISOString(),
  expected: { accountId: process.argv[2], clusterArn: `arn:aws:ecs:us-east-2:${process.argv[2]}:cluster/telesphoros-staging-api`,
    serviceArn: `arn:aws:ecs:us-east-2:${process.argv[2]}:service/telesphoros-staging-api/telesphoros-staging-api`, taskDefinitionArn: process.argv[3], image: process.argv[4] },
  services: r("services.json"), runningTaskArns: r("running.json"), stoppedTaskArns: r("stopped.json"), tasks: r("tasks.json"), taskDefinition: r("taskdef.json") };
f.writeFileSync(process.argv[1] + "/observation.json", JSON.stringify(packet), { mode: 0o600 });
' "$PK" "$STAGING_ACCOUNT_ID" "$TD_ARN" "$NEW" || fail "cannot assemble the observation packet"
FENCE=$(node "$HERE/../check-medication-fence-rollout.mjs" "$PK/observation.json" </dev/null); FX=$?
echo "   checker: $FENCE (exit $FX)"
[ "$FX" = 0 ] || fail "the fence checker holds (reasons above)"

echo "== 6. Synthetic assessment settings in the API task definition (current.tfvars: $WANTSET)"
node -e '
const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).taskDefinition.containerDefinitions[0];
const env = c.environment ?? [], want = { SYNTHETIC_ASSESSMENT: "enabled", SYNTHETIC_KNOWLEDGE_DIR: "/app/synthetic-knowledge" };
const on = process.argv[2] === "present", problems = [];
for (const [name, value] of Object.entries(want)) {
  const hits = env.filter((e) => e.name === name);
  if (on && !(hits.length === 1 && hits[0].value === value)) problems.push(name + " is not exactly " + value);
  if (!on && hits.length) problems.push(name + " is set, but current.tfvars switches the assessment off");
  if ((c.secrets ?? []).some((s) => s.name === name)) problems.push(name + " is also a secret");
}
if ((c.environmentFiles ?? []).length) problems.push("an environment file could override the settings");
console.log(problems.length ? problems.join("; ") : "   as expected"); process.exit(problems.length ? 1 : 0);
' "$PK/taskdef.json" "$WANTSET" || fail "the synthetic assessment settings are not as expected (above)"

echo "== Result"
if [ "$FAIL" = 0 ]; then
  { echo "verified $(date -u +%Y-%m-%dT%H:%M:%SZ) $MODE${OPERATION:+ $OPERATION}"; echo "current $CURSHA"; echo "image $NEW"; echo "assessment $WANTSET"
    echo "fence $FENCE"; echo "ledger $LEDGER"; } > "$OUT/verify-ok.txt.tmp" && mv "$OUT/verify-ok.txt.tmp" "$OUT/verify-ok.txt"
  echo "ALL CHECKS PASSED: ${OUT#"$PRIVATE"/}/verify-ok.txt written."
else
  echo "SOME CHECKS FAILED (above): nothing written."
  exit 1
fi
