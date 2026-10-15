# Staged rehearsal: the one-off database tasks (FD-7 slice 3)

**Status: the runner and its tests exist. It has never started a task in AWS, and nothing in AWS exists yet.** Synthetic data only. This page is the order of the first staged bring-up from the point where
the stack and the image exist; the plan is [fd7-staged-synthetic-deploy.md](../design/plans/fd7-staged-synthetic-deploy.md), and nothing here approves an apply (the gates in `infrastructure/terraform/README.md` still hold).

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

1. **Apply the foundations** with `enable_api_hosting = true` and no `api_image` (this creates the registry, the secret containers, the database, the cluster, the log group). Plan first, read it, then apply: see the plan's first-apply gates.
2. **Build and push the image**, resolve its digest ([image-push.md](image-push.md)).
3. **Set the two keys that are not database logins**, by hand, once (`aws secretsmanager put-secret-value`, 64 hex characters from `openssl rand -hex 32` each): `.../api/invitation-digest-key` and `.../api/identifier-digest-key` ([api-hosting.md](api-hosting.md#the-database-logins-db-provision-logins)). The service refuses to start without them. Do not rotate the identifier key casually.
4. **Set `api_image` to the digest and apply again.** This creates the task definitions **and also the API and worker services**, which start at once. Until steps 5 to 8 are done their tasks cannot start (their database-login secrets are empty) and ECS will report failed tasks; the deployment circuit breaker is expected to stop retrying. That is expected, and **not yet observed in AWS**. (`api_desired_count` cannot be set to 0, so there is no way to hold the services back; see Follow-ups.)
5. `scripts/staging/run-task.sh provision-logins --yes`. Expect `created` for the four logins, `SKIP` for the group-privilege check (nothing is migrated yet), and `LOGINS READY`.
6. `scripts/staging/run-task.sh migrate-up --yes`. Expect `applied: ...` listing the migrations. Then `migrate-status` should show `pending: (none)`.
7. `scripts/staging/run-task.sh provision-logins --require-migrated --yes`. Expect `unchanged` for each login, `PASS` for every group-privilege check, and `LOGINS READY`. A `FAIL` means the privileges are wrong: stop and read the line.
8. `scripts/staging/run-task.sh tenant-create --id <id> --name "<name>" --by "<you>" --yes`, expect `registered: id=<id> ... status=active`. Create the person's account in Cognito by hand (a `tenant:<id>` group and the person in it; [auth.md](../auth.md#inviting-and-removing-people-runbook)), then
   `scripts/staging/run-task.sh membership-grant --tenant <id> --sub <cognito sub> --roles admin --by "<you>" --reason "..." --yes`, expect `granted: tenant=<id> sub=... status=active roles=admin`. `membership-show` and `tenant-list` read the result back.
9. **Restart the services** now that the logins and the schema exist: `aws ecs update-service --cluster "$ECS_CLUSTER" --service "$(terraform output -raw api_service_name)" --force-new-deployment` and the same for `worker_service_name`. Then watch the four alarms and `/api/v1/ready` ([api-hosting.md](api-hosting.md#releasing-after-f4-exists)).

A later release runs `migrate-up` before the new `api_image` is applied, as before.

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
