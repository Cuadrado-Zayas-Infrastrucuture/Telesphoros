#!/usr/bin/env bash
# Run one of the database one-off tasks in AWS and print its log (FD-7 slice 3). Synthetic staging; run from a person's shell.
#
#   scripts/staging/run-task.sh <step> [flags]          dry run (default): validates and prints the exact aws command, runs nothing
#   scripts/staging/run-task.sh <step> [flags] --yes    runs the task, waits for it to stop, prints its log, exits non-zero unless it exited 0
#
# Steps (each is one command of apps/backend/src/db/cli.ts; the migration task's login is the table owner's, which is all these need):
#   provision-logins [--rotate] [--require-migrated]     the provisioning task (creates the database logins; safe to run twice)
#   migrate-up                                           the migration task as it is defined
#   migrate-status                                       migrate status (read-only)
#   tenant-create --id ID --name NAME --by NAME          register an organization
#   tenant-list                                          list organizations (read-only)
#   membership-grant --tenant ID --sub SUB --roles LIST --by NAME [--reason TEXT]
#   membership-show --tenant ID --sub SUB                show one membership (read-only)
# Deliberately absent: migrate down, tenant suspend, membership remove, and anything that rotates or deletes. Do those by hand, knowingly.
#
# Required environment (from `terraform output -raw ...`, except the region):
#   AWS_REGION                  the region of the stack
#   ECS_CLUSTER                 api_cluster_name
#   MIGRATE_TASK_FAMILY         api_migrate_task_family          (migrate-*, tenant-*, membership-*)
#   PROVISION_TASK_FAMILY       api_provision_task_family        (provision-logins)
#   TASK_SUBNETS                api_task_subnet_ids, comma separated
#   TASK_SECURITY_GROUP         api_tasks_security_group_id
#   TASK_ASSIGN_PUBLIC_IP       api_task_assign_public_ip (true or false: there is no default, so a wrong guess cannot happen silently)
#   API_LOG_GROUP               api_log_group
# Docs: docs/ops/staging-rehearsal.md
set -euo pipefail

die() { echo "run-task: $*" >&2; exit 1; }

[[ $# -ge 1 && "$1" != --* ]] || die "a step is required (see the header of this script)"
step="$1"; shift

apply=0
args=()
for arg in "$@"; do
  if [[ "$arg" == "--yes" ]]; then apply=1; else args+=("$arg"); fi
done

# ---- 1. The environment ------------------------------------------------------------------------------------------------
for name in AWS_REGION ECS_CLUSTER MIGRATE_TASK_FAMILY PROVISION_TASK_FAMILY TASK_SUBNETS TASK_SECURITY_GROUP TASK_ASSIGN_PUBLIC_IP API_LOG_GROUP; do
  [[ -n "${!name:-}" ]] || die "$name is not set (see the header of this script)"
done
[[ "$AWS_REGION" =~ ^[a-z]{2}(-[a-z]+)+-[0-9]$ ]] || die "AWS_REGION is not a region name: $AWS_REGION"
[[ "$ECS_CLUSTER" =~ ^[A-Za-z0-9_-]{1,255}$ ]] || die "ECS_CLUSTER is not a cluster name: $ECS_CLUSTER"
for name in MIGRATE_TASK_FAMILY PROVISION_TASK_FAMILY; do
  [[ "${!name}" =~ ^[A-Za-z0-9_-]{1,255}$ ]] || die "$name is not a task family name: ${!name}"
done
[[ "$TASK_SUBNETS" =~ ^subnet-[0-9a-f]{8,17}(,subnet-[0-9a-f]{8,17})*$ ]] || die "TASK_SUBNETS must be subnet ids separated by commas: $TASK_SUBNETS"
[[ "$TASK_SECURITY_GROUP" =~ ^sg-[0-9a-f]{8,17}$ ]] || die "TASK_SECURITY_GROUP is not a security group id: $TASK_SECURITY_GROUP"
# macOS's regex engine refuses repetition bounds above 255; check the AWS length limit separately.
[[ ${#API_LOG_GROUP} -le 512 && "$API_LOG_GROUP" =~ ^[A-Za-z0-9_./#-]+$ ]] || die "API_LOG_GROUP is not a log group name: $API_LOG_GROUP"
case "$TASK_ASSIGN_PUBLIC_IP" in
  true) public_ip="ENABLED" ;;
  false) public_ip="DISABLED" ;;
  *) die "TASK_ASSIGN_PUBLIC_IP must be true or false (found: $TASK_ASSIGN_PUBLIC_IP)" ;;
esac

# ---- 2. The step: its task, container and command; every value checked against the CLI's own rules ----------------------
# The command is built with node from the arguments themselves (never through a shell), so no value is ever interpreted.
text_ok() { # value, max length
  local value="$1" max="$2"
  [[ -n "$value" && ${#value} -le $max && "$value" != *[[:cntrl:]]* ]]
}
tenant_ok() { [[ "$1" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]]; }                  # tenantIdSchema (packages/shared-types/src/tenant.ts)
sub_ok() { [[ "$1" =~ ^[A-Za-z0-9._:@+-]{1,128}$ && "$1" != system:* ]]; }  # a person's subject id; stricter than the CLI's "no control characters" (a Cognito sub is a UUID)
roles_ok() { # a non-empty comma list of known roles (roles.ts)
  local role
  [[ "$1" =~ ^[a-z]+(,[a-z]+)*$ ]] || return 1  # also refuses an empty entry, which `read -a` would silently drop
  IFS=',' read -r -a list <<<"$1"
  for role in "${list[@]}"; do
    case "$role" in reader|clinician|admin|reviewer) ;; *) return 1 ;; esac
  done
}

# Parse "--name value" pairs against an allowed list; sets F_<name> variables (no associative arrays: this runs on macOS's bash 3.2 too).
parse_flags() { # allowed names (space separated), then the arguments
  local allowed=" $1 "; shift
  while [[ $# -gt 0 ]]; do
    [[ "$1" == --* ]] || die "unexpected argument: $1"
    local name="${1#--}"
    [[ "$allowed" == *" $name "* ]] || die "unknown flag for $step: $1"
    [[ $# -ge 2 ]] || die "$1 needs a value"
    local var="F_$name"
    [[ -z "${!var+x}" ]] || die "$1 given twice"
    printf -v "$var" '%s' "$2"; shift 2
  done
}
need() { local var="F_$1"; [[ -n "${!var+x}" ]] || die "--$1 is required for $step"; }

family=""; container=""; stream_prefix=""; cli=()
case "$step" in
  provision-logins)
    family="$PROVISION_TASK_FAMILY"; container="provision"; stream_prefix="provision"
    cli=(provision-logins)
    for flag in "${args[@]+"${args[@]}"}"; do
      case "$flag" in --rotate|--require-migrated) cli+=("$flag") ;; *) die "unknown flag for provision-logins: $flag" ;; esac
    done ;;
  migrate-up|migrate-status)
    family="$MIGRATE_TASK_FAMILY"; container="migrate"; stream_prefix="migrate"
    [[ ${#args[@]} -eq 0 ]] || die "$step takes no arguments"
    cli=(migrate "${step#migrate-}") ;;
  tenant-list)
    family="$MIGRATE_TASK_FAMILY"; container="migrate"; stream_prefix="migrate"
    [[ ${#args[@]} -eq 0 ]] || die "tenant-list takes no arguments"
    cli=(tenant list) ;;
  tenant-create)
    family="$MIGRATE_TASK_FAMILY"; container="migrate"; stream_prefix="migrate"
    parse_flags "id name by" "${args[@]+"${args[@]}"}"
    need id; need name; need by
    tenant_ok "${F_id}" || die "--id must be lower-case letters, digits and dashes, 1 to 63 characters, not starting with a dash"
    text_ok "${F_name}" 120 || die "--name must be 1 to 120 characters without control characters"
    text_ok "${F_by}" 128 || die "--by must be 1 to 128 characters without control characters"
    cli=(tenant create --id "${F_id}" --name "${F_name}" --by "${F_by}") ;;
  membership-grant)
    family="$MIGRATE_TASK_FAMILY"; container="migrate"; stream_prefix="migrate"
    parse_flags "tenant sub roles by reason" "${args[@]+"${args[@]}"}"
    need tenant; need sub; need roles; need by
    tenant_ok "${F_tenant}" || die "--tenant must be an organization id (lower-case letters, digits and dashes)"
    sub_ok "${F_sub}" || die "--sub must be the person's subject id (letters, digits and . _ : @ + -, at most 128, never system:...)"
    roles_ok "${F_roles}" || die "--roles must be a comma-separated list of reader, clinician, admin, reviewer"
    text_ok "${F_by}" 128 || die "--by must be 1 to 128 characters without control characters"
    cli=(membership grant --tenant "${F_tenant}" --sub "${F_sub}" --roles "${F_roles}" --by "${F_by}")
    if [[ -n "${F_reason+x}" ]]; then
      text_ok "${F_reason}" 500 || die "--reason must be 1 to 500 characters without control characters"
      cli+=(--reason "${F_reason}")
    fi ;;
  membership-show)
    family="$MIGRATE_TASK_FAMILY"; container="migrate"; stream_prefix="migrate"
    parse_flags "tenant sub" "${args[@]+"${args[@]}"}"
    need tenant; need sub
    tenant_ok "${F_tenant}" || die "--tenant must be an organization id (lower-case letters, digits and dashes)"
    sub_ok "${F_sub}" || die "--sub must be the person's subject id (letters, digits and . _ : @ + -, at most 128, never system:...)"
    cli=(membership show --tenant "${F_tenant}" --sub "${F_sub}") ;;
  *) die "unknown step: $step (see the header of this script)" ;;
esac

overrides="$(node -e '
  const [container, ...command] = process.argv.slice(1);
  process.stdout.write(JSON.stringify({ containerOverrides: [{ name: container, command: ["node", "dist/db/cli.js", ...command] }] }));
' "$container" "${cli[@]}")"
network="awsvpcConfiguration={subnets=[$TASK_SUBNETS],securityGroups=[$TASK_SECURITY_GROUP],assignPublicIp=$public_ip}"

# ---- 3. Dry run, or run ------------------------------------------------------------------------------------------------
run_args=(ecs run-task --region "$AWS_REGION" --cluster "$ECS_CLUSTER" --task-definition "$family" --launch-type FARGATE --count 1
  --network-configuration "$network" --overrides "$overrides" --query 'tasks[0].taskArn' --output text)
if [[ "$apply" -ne 1 ]]; then
  echo "dry run: nothing started. Step $step would run:"
  printf '  aws'; printf ' %q' "${run_args[@]}"; echo
  echo "  command override: $overrides"
  echo "  then: aws ecs wait tasks-stopped, aws ecs describe-tasks (exit code), aws logs get-log-events ($API_LOG_GROUP, stream $stream_prefix/$container/<task id>)"
  echo "run again with --yes to start it"
  exit 0
fi

command -v aws >/dev/null || die "the AWS CLI is not installed"
echo "running as:"
aws sts get-caller-identity --query '[Account,Arn]' --output text
task_arn="$(aws "${run_args[@]}")"
[[ "$task_arn" =~ ^arn:aws[a-z-]*:ecs:[a-z0-9-]+:[0-9]{12}:task/[A-Za-z0-9_-]+/[0-9a-f]{32}$ ]] || die "the task did not start (aws returned: ${task_arn}); check the cluster, subnets and security group, and the service quotas"
task_id="${task_arn##*/}"
echo "started $task_id; waiting for it to stop (up to ten minutes)"
aws ecs wait tasks-stopped --region "$AWS_REGION" --cluster "$ECS_CLUSTER" --tasks "$task_arn" || die "the task did not stop in time: $task_arn (look at it in the console; it may still be running)"
exit_code="$(aws ecs describe-tasks --region "$AWS_REGION" --cluster "$ECS_CLUSTER" --tasks "$task_arn" --query "tasks[0].containers[?name=='$container'] | [0].exitCode" --output text)"
reason="$(aws ecs describe-tasks --region "$AWS_REGION" --cluster "$ECS_CLUSTER" --tasks "$task_arn" --query 'tasks[0].stoppedReason' --output text)"
sleep "${LOG_DELAY_SECONDS:-5}"
echo "---- log: $API_LOG_GROUP $stream_prefix/$container/$task_id ----"
aws logs get-log-events --region "$AWS_REGION" --log-group-name "$API_LOG_GROUP" --log-stream-name "$stream_prefix/$container/$task_id" --start-from-head --query 'events[].message' --output text \
  || echo "(no log could be read: the task may have failed before it wrote anything; its stopped reason is below)"
echo "---- end of log ----"
if [[ "$exit_code" == "0" ]]; then
  echo "$step: the task exited 0"
  exit 0
fi
die "$step: the task did not succeed (exit code: ${exit_code}; stopped reason: ${reason})"
