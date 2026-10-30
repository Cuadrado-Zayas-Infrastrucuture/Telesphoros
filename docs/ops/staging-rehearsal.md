# Staged rehearsal: the one-off database tasks (FD-7 slice 3)

**Status: the runner and its tests exist; live AWS execution remains unverified.** Synthetic data only. This page is the order of the first staged bring-up from the point where
the stack and the image exist; the plan is [fd7-staged-synthetic-deploy.md](../design/plans/fd7-staged-synthetic-deploy.md), and nothing here approves an apply (the gates in `infrastructure/terraform/README.md` still hold).

[Foundations readiness](foundations-readiness.md) is the entry gate: account,
budget, state and BAA/manual-session decisions remain pending. Historical absence
claims do not establish an empty target. The commands below are for a later
authorized session, not instructions to access AWS during offline preparation.

## The runner

`scripts/staging/run-task.sh <step> [flags]` starts one of the two existing one-off task definitions with a command override, waits for it to stop, prints the log of that task, and exits 0 only if the container exited 0.
**The default is a dry run** that prints the exact `aws ecs run-task` command and override; `--yes` runs it. It creates no task definition and needs no new permission: the commands are the ones already in `apps/backend/src/db/cli.ts`.

| Step | Runs | Task |
| --- | --- | --- |
| `provision-logins [--rotate] [--require-migrated]` | `provision-logins ...` | provisioning task |
| `migrate-up`, `migrate-status` | `migrate up`, `migrate status` | migration task |
| `tenant-create --id ID --name NAME --by NAME`, `tenant-list` | `tenant create`, `tenant list` | migration task |
| `membership-grant --tenant ID --sub SUB --roles LIST --by NAME [--reason TEXT]`, `membership-show --tenant ID --sub SUB` | `membership grant`, `membership show` | migration task |

`tenant ...` and `membership ...` need only the table owner's login (`DATABASE_MIGRATOR_URL`), which the migration task already holds; that is why no new task definition or IAM exists.
**Left out on purpose:** `migrate down`, suspending an organization, removing a member, `provision-logins` variants not listed. Do those by hand, knowingly.

Values are checked before anything starts, against the application's own rules: organization ids `^[a-z0-9][a-z0-9-]{0,62}$`; roles from `reader, clinician, admin, reviewer` (at least one, no empty entry);
a subject id of letters, digits and `. _ : @ + -` (at most 128, never `system:...`, stricter than the CLI, which only refuses control characters); `--by` at most 128, `--name` at most 120, `--reason` at most 500 characters, none with control characters.
Free text is passed to the container as data (the override is built by `node`, never through a shell), so a quote or `$(...)` in a name is just text.
The runner supports macOS's stock Bash 3.2 as well as Linux Bash. Log-group names accept 1 to 512 ASCII letters, digits and `_ . / # -`; character and length checks are separate so macOS can validate the full range.

### Environment

```sh
cd infrastructure/terraform
export AWS_REGION=<region>
export ECS_CLUSTER=$(terraform output -raw api_cluster_name)
export MIGRATE_TASK_FAMILY=$(terraform output -raw api_migrate_task_family)
export PROVISION_TASK_FAMILY=$(terraform output -raw api_provision_task_family)
export TASK_SUBNETS=$(terraform output -json api_task_subnet_ids | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).join(","))')
export TASK_SECURITY_GROUP=$(terraform output -raw api_tasks_security_group_id)
export TASK_ASSIGN_PUBLIC_IP=$(terraform output -raw api_task_assign_public_ip)   # true under the synthetic profile with its own network (no NAT), false otherwise
export API_LOG_GROUP=$(terraform output -raw api_log_group)
cd ../..
```

There is no default for `TASK_ASSIGN_PUBLIC_IP`: a task without a route to the registry and AWS services stops at once with `CannotPullContainerError`. The task definitions exist only after `api_image` is set.
The script prints the AWS account and identity before it starts anything: check them (`aws sts get-caller-identity`) before using `--yes`.

## The order

1. After approved backend activation, **review and apply A, then B** as separate saved plans ([plan review](staging-plan-review.md)): A has `enable_api_hosting = true`, web off and no `api_image`; B adds web hosting. A creates the registry, secret containers, database, cluster and log groups. Both certificate waits need Jan's validation CNAMEs; no services exist yet.
2. **Get the image into ECR and verify it** ([image-push.md](image-push.md)): CI's `release-image` pushes and signs it (or, only if CI cannot, a break-glass manual push), then `scripts/staging/verify-image.mjs` writes the verification record that plan C's check requires.
3. **Set the two keys that are not database logins**, by hand, once (`aws secretsmanager put-secret-value`, 64 hex characters from `openssl rand -hex 32` each): `.../api/invitation-digest-key` and `.../api/identifier-digest-key` ([api-hosting.md](api-hosting.md#the-database-logins-db-provision-logins)). The service refuses to start without them. Do not rotate the identifier key casually.
4. **Review/check plan C, set `api_image` to the digest and apply only the approved saved plan.** This creates the task definitions **and also the API and worker services**, which start at once. Until steps 5 to 8 are done their tasks cannot start (their database-login secrets are empty) and ECS will report failed tasks; the deployment circuit breaker is expected to stop retrying. That is expected, and **not yet observed in AWS**. Both desired counts require at least one; accept this bounded first-start test explicitly or request a separate service-hold change. Stop and preserve errors if behavior differs; do not disable guards to proceed.
5. `scripts/staging/run-task.sh provision-logins --yes`. Expect `created` for the five logins (the fifth is the session issuer's: the provisioning task names its secret, so it is created even though `enable_issuer` stays off), `SKIP` for the group-privilege check (nothing is migrated yet, so the issuer login's check is skipped too), and `LOGINS READY`.
6. `scripts/staging/run-task.sh migrate-up --yes`. Expect `applied: ...` listing the migrations. Then `migrate-status` should show `pending: (none)`.
7. `scripts/staging/run-task.sh provision-logins --require-migrated --yes`. Expect `unchanged` for each of the five logins, `PASS` for every group-privilege check (including the issuer login's, which can only be judged after migration 0028 from `migrate-up`), and `LOGINS READY`. A `FAIL` means the privileges are wrong: stop and read the line.
   Then `scripts/staging/run-task.sh connection-limits --yes` (read-only). It prints `max_connections`, the slots the server keeps back, each login's own `CONNECTION LIMIT`, and `db_connection_budget = N`. Set that value in the stack's variables and plan again: until then the plan checks the services against a class estimate, labelled as one, and production refuses the estimate. Keep the printed lines with the rehearsal record.
8. `scripts/staging/run-task.sh tenant-create --id <id> --name "<name>" --by "<you>" --yes`, expect `registered: id=<id> ... status=active`. Create the person's account in Cognito by hand (a `tenant:<id>` group and the person in it; [auth.md](../auth.md#inviting-and-removing-people-runbook)), then
   `scripts/staging/run-task.sh membership-grant --tenant <id> --sub <cognito sub> --roles admin --by "<you>" --reason "..." --yes`, expect `granted: tenant=<id> sub=... status=active roles=admin`. `membership-show` and `tenant-list` read the result back.
9. **Restart the services** now that the logins and the schema exist: from the repository root, `aws ecs update-service --cluster "$ECS_CLUSTER" --service "$(terraform -chdir=infrastructure/terraform output -raw api_service_name)" --force-new-deployment` and the same for `worker_service_name`. Then watch the API and worker alarms and `/api/v1/ready` ([API runbook](api-hosting.md), [worker checks](jobs.md#deployment-m23c)).
10. Seed existing synthetic patients through authorized APIs, dry-run the normal frontend publisher, then separately approve publishing and staging traffic records. Verify the [current hosted intake and cleanup boundaries](foundations-readiness.md#hosted-acceptance-follows-current-application-behavior); normal hosting has no Reports dashboard.

A later release is a separate FD-5 upgrade/rollback contract; first-bring-up success
does not establish compatibility between old images and newer migrations. Do not
reuse this initial-setup sequence as an approved rolling-release procedure.

## Where the output is

The runner prints the task's log after it stops (stream `migrate/migrate/<task id>` or `provision/provision/<task id>` in the group `api_log_group`); the same lines stay in CloudWatch for the log group's retention.
A task that fails before it writes anything (a pull error, a missing secret) has no log: the runner then prints its stopped reason. Logs can arrive a few seconds late; if the log is empty for a task that exited 0, read it again in the console.
The commands print no connection string, password or token; they do print organization ids, names and subject ids, which are synthetic here.

## Safe to repeat?

`provision-logins` and `migrate-up` are safe to run twice (`unchanged`, `nothing to apply`). `tenant-create` for an existing id is refused (`refused: ... already registered`), and `membership-grant` for an active member is refused: read the message, then use `membership-show`.
`provision-logins --rotate` replaces every password and needs the services restarted afterwards; it is a deliberate act.

## What this does not prove

Not verified until a real account exists: that ECS accepts the arguments, that the tasks start (image pull, secret injection, the Fargate read-only filesystem), that RDS accepts the administrator's grants (`rds_superuser`), the exact log lines, that the services fail and recover as described in step 4,
and cost. The runner's tests (`scripts/staging/run-task.test.mjs`, run by `pnpm test:infra`) check the commands it builds, every refusal, the order of the calls with a stand-in `aws`, and that it agrees with the CLI, the Terraform and this page's names.

## Follow-ups (decisions, not part of this slice)

- Setting `api_image` starts the services before the logins exist (step 4). Allowing a synthetic hold, for example `api_desired_count = 0`, would need a change to the existing `api_desired_count >= 1` rule and its guards. Decide after the first rehearsal shows how the circuit breaker behaves.
