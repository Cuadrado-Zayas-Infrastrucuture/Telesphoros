# M2.3c the worker's deployment: verification

Implementation on branch `claude/m2-3c-worker-deploy`, stacked on M2.3b (`claude/m2-3b-outbox-consumers`; M2.3a is merged as #100). Plan and decisions: [m2-3-jobs-outbox-worker.md](../design/plans/m2-3-jobs-outbox-worker.md), which records where the build differs. Results were captured locally on 2026-10-14. Synthetic data only; **nothing is applied in AWS and the container image was not built here** (no container engine in this environment).

## What was implemented

| Change | Where |
| --- | --- |
| Worker Terraform: log group and key, secret container, security group (no inbound), task and execution roles, task definition and service on the API's cluster (no load balancer), four alarms, two outputs; variables for count, CPU, memory | `infrastructure/terraform/worker.tf` |
| Read-only task policy (`s3:GetObject`/`GetObjectVersion` on `reports/*`, `kms:Decrypt` through S3 only) | `iam.tf` |
| The provisioning task names and may write the fourth secret | `api-compute.tf` |
| The worker bundle in the image, started as `node worker/main.js`; a worker mode in the image rehearsal (start, `/livez`, `/readyz`, SIGTERM exit 0) | `infrastructure/docker/` |
| The worker login (`telesphoros_job_worker`, `telesphoros_worker` only) created and read back by `provision-logins`; the migration login also granted the queue's owner role | `apps/backend/src/db/provision-logins.ts`, `cli.ts` |
| Migration 0025: `job_stats` ignores held jobs when aging the queue | `apps/backend/migrations/0025_*` |
| `queue-stats` log line each minute (`WORKER_STATS_SECONDS`) | `apps/worker` |
| Docs | the plan ("as built"), `ops/jobs.md` (deployment, alarms), `ops/api-hosting.md`, `database.md`, STATUS |

## Tests added or changed

| Test | Proves |
| --- | --- |
| `worker.guard.test.mjs` (2, 60+ weakened copies) | The Terraform text: counted by the hosting switch (task and service also by the image); no secret value; the task role is read-only on exact report files; the execution role reads only the worker secret; no inbound traffic, egress to the database and HTTPS only; read-only, non-root, no published port, no shell, no load balancer, rollback; the environment has what production needs and no secret or test setting; alarm patterns match literals the worker writes; the worker-side log literals are still present |
| `apps/worker/src/deploy-contract.test.ts` (8) | The Terraform environment is accepted by the worker's own loader as production and refused when broken; the stop timeout exceeds the drain; the bundle path matches the Dockerfile; each CloudWatch pattern is evaluated against the lines the worker's own logger writes (a dead job, a failed check, a clean one, `queue-stats`) |
| `test/queue.pg.test.ts` (+1), `test/processes.pg.test.ts` (+1) | A suspended organization's held jobs do not age the queue; a running worker writes the `queue-stats` line with numeric fields |
| `provision-logins.pg-spec.ts` (+2), `provision-logins.spec.ts` | Four logins; the worker login can run the queue's functions and nothing else (live attempts); a worker that can read a clinical table, write a queue table or run an application function fails the check and recovers when revoked |
| `profiles.tftest.hcl` (+3 asserts), `profile.guard.test.mjs`, `api-compute.guard.test.mjs` | The worker exists exactly when hosting is on; follows the profile (recovery windows, public address); four provisioning secrets |
| Docker guard | The worker bundle is built and copied (with mutation controls) |
| Migration-list specs | Updated for 0025 |

## Defect injection

Each rule broken on purpose by script (`inject10.py`), the relevant suites run, the file restored.

| Injected defect | Result |
| --- | --- |
| `job_stats` ages the queue with held jobs | 1 failed |
| The worker login not created; the worker may run every function; the worker's group is the application group | 12, 3, 4 failed |
| The worker may read every table | survived at first; after adding the test, 1 failed |
| The `queue-stats` ticker never starts | survived at first; after adding the process test, 1 failed |
| `queue-stats` drops the age; a pattern reads another outcome or event; the container stops before the drain; the health check probes another port; the environment loses the bucket | caught by the guard and/or the contract test (2 failed in the guard, 1 to 3 in the contract test; the port change by the contract test alone) |
| The task role may write report files; the execution role reads the API secret; a load balancer reaches the worker | 2 failed in the guard (each) |
| **Survived, judged equivalent:** `job_stats` joins `tenants` with an inner join | `jobs.tenant_id` is a foreign key to `tenants` (`ON DELETE RESTRICT`), so every job has a tenant row; `LEFT JOIN` is harmless but not needed |

## Local results

| Check | Result |
| --- | --- |
| Typecheck, lint (whole workspace) | pass |
| `terraform validate`, `fmt -check`, `terraform test` (13 runs, providers mocked) | pass |
| `test:infra`, `test:ci-config`, `test:image` | 34, 36, 21 passed |
| Backend on PostgreSQL uploading over S3, 152 suites (recovery suites excluded) | 2,202 passed, 1 skipped, 0 failed (before the two new tests; `provision-logins` re-run after: 20 passed) |
| Worker on PostgreSQL and the S3 emulator | 121 passed (13 files), before the process test; `processes.pg` re-run after: 8 passed |
| Recovery suites as an unprivileged user from a repository copy | 97 passed |
| Packages in the in-memory tier (`jobs`, `cpic-schema`, `fake-idp`, `shared-types`, the lambda) | passed |

## What this does not show

- No remote CI has run on this slice. **The Docker image was not built and its worker rehearsal was not run**; the Dockerfile and rehearsal edits are checked by the image guard (text) only.
- The full in-memory workspace run and the backend run against PostgreSQL with the in-memory object store (CI's tier 2) were **not repeated** after the last test additions; the S3 tier covers the same code.
- Terraform has never been applied: IAM, quotas, ECS and CloudWatch behavior (including that the metric filters parse these JSON patterns) are shown only by the text guards, mocked plans and the pattern evaluator in the contract test.
- No alarm has fired against a real worker log; the thresholds (15 minutes, five minutes) are judgment, not measurement.
