# Plan FD-4: database logins, the API image, and a CI rehearsal of the first deployment

Status: **approved 2026-10-09** with the founder's decisions below. **PR 1 (the command, FD-4a) is built; PR 2 (the image and rehearsal, FD-4b) is not started.** Needs no AWS access: everything is proved against a throwaway Postgres.

## Why

After FD-1 to FD-3 the Terraform can describe a running API, but nothing can run it: there is **no Dockerfile**, and no tool creates the three database logins the API refuses to start without (the repository's own docs say "the first deployment cannot start" until one exists). FD-4 closes those two gaps and rehearses the whole first deployment in CI, so the FD-7 AWS run is not the first time anyone starts this application read-only, as user 10001, with strict database TLS and the production environment.

## What I found (checked, not assumed)

- Build: `tsc` to `dist/`; `migrations/` beside it; `@telesphoros/shared-types` and `cpic-schema` consumed from their own `dist/`. Migration command: `node dist/db/cli.js migrate up`. CI pins Node **22.22.0** exactly (the report adapter refuses another ICU).
- Roles: migrations create the groups `NOLOGIN`; no code creates a login. Verifier login must be a member of `telesphoros_ledger_verifier` only (never `telesphoros_app`, or it inherits the right to append). The migrator needs `CREATEROLE`-class rights and `SET` on `telesphoros_ledger` / `telesphoros_redactor` (ledger-roles.md).
- **Changed since the original F4 plan (FD-1):** connection strings may carry **no TLS parameters**; the old plan's "`?sslmode=require`" would now be refused at start-up. TLS comes only from `DATABASE_SSL=require`, and trust only from `NODE_EXTRA_CA_CERTS` pointing at Amazon's RDS bundle, which must be in the image.
- The RDS bundle (`truststore.pki.rds.amazonaws.com/global/global-bundle.pem`) fetched here: 111 certificates, 169 984 bytes, SHA-256 `fe45bbebf92ad3e27a583bbb2ddd1553c521ed4d49af5514dc0a40372ea5395c`. **That download went through this sandbox's TLS-intercepting proxy, so it is not independent evidence.** See decision 3.
- Docker's client is here but **no daemon**: I cannot build or run the image locally. The first real build is in CI and I will iterate there and say so. Docker Hub's registry answers from here, so I can try to resolve the base image digest; if I cannot, CI prints it and a one-line follow-up pins it.
- Fargate has no `tmpfs`; F3b sets a read-only root filesystem. If the rehearsal shows the app writes to `/tmp`, F3b needs a small mounted volume.

## What I will build: two PRs, each off `main`, one after the other

### PR 1 (FD-4a): `db provision-logins`

A command in the same CLI (`src/db/cli.ts`), run as a **one-off task** with the RDS-managed admin secret:

1. Connects as the admin (strict TLS, FD-1 builder) and creates three logins: the application login (member of `telesphoros_app` only), the ledger-verifier login (member of `telesphoros_ledger_verifier` only), and the migrator (owns the schema objects; `CREATEROLE`, `CREATE` on the database and `public`, then the two `SET` grants). Passwords are **generated 256-bit, URL-safe, never printed, logged or returned**.
2. Writes each connection string (**no TLS parameters**) straight into the three Secrets Manager secrets F3b already declares (`PutSecretValue`).
3. **Idempotent**: a second run changes nothing unless `--rotate`. After every run it verifies each login's memberships from the catalog and **fails** if the verifier login can execute `ledger_append` or is in `telesphoros_app`, or if the application login can execute any incident or checkpoint function.
4. Terraform (counted by the hosting switch; unapplied): a provisioning task definition, an execution role that can read only the admin secret, a task role that can only `PutSecretValue` on exactly the three secrets, and a task-definition output. Extends the `terraform test` profile runs and the text guards (with controls).
5. New dependency `@aws-sdk/client-secrets-manager`, used only by this command.
6. The human **operator** login (break-glass, ledger-roles.md) is **not** created by this command: a person decides when it exists.

Tests: the PostgreSQL tier (roles, memberships, idempotence, rotation, the two refusals above, and that **no password pattern appears in stdout, stderr, logs or errors**), the Secrets Manager call against moto (already a CI service), the Terraform text guards with controls, **defect injection** with a green control. The admin used in tests is a **non-superuser with `CREATEROLE`**, as close to `rds_superuser` as stock Postgres allows (PG16 restricts who may grant roles). **Not verifiable here:** RDS itself; the first run on real RDS (FD-7) is the true test, and the PR says so.

### PR 2 (FD-4b): the image and the rehearsal

1. `infrastructure/docker/api.Dockerfile` + `.dockerignore`. Multi-stage; the pinned pnpm; `pnpm deploy --prod` for production dependencies only (no test tools, no fake identity provider, no sources); runtime on the **official `node:22.22.0-bookworm-slim`, pinned by digest** (keeps the exact Node and ICU the code needs). User `10001`, `NODE_ENV=production`, `NODE_EXTRA_CA_CERTS` to the vendored bundle, exec-form entrypoint, no shell scripts, no `HEALTHCHECK` (the load balancer does it), **no Python** (the lab-report reader is refused in production).
2. The RDS bundle vendored under `infrastructure/docker/` with its SHA-256 recorded and **checked at build**, so a changed file fails the build.
3. A new CI job **`image`**: build with BuildKit, SBOM and provenance on, **no push**; scan with Trivy (SHA-pinned action), failing on **critical/high with a fix**, with a reviewed allow-list file; then the **rehearsal**: a throwaway CA and a Postgres 16 with TLS on, then the image's own commands in order: `provision-logins`, `migrate up`, start the API as production would (`--read-only`, `--user 10001`, the F3b environment, `DATABASE_SSL=require`, trust only through `NODE_EXTRA_CA_CERTS`) and check `/api/v1/health` 200, `/api/v1/ready` **503 before** the migrations and **200 after**, an unauthenticated request 401, and that the second task of a pair contains a tenant the first one recorded (the FD-2 rule, end to end).
4. A guard on the Dockerfile text (digest-pinned base, numeric non-root user, no `ARG` credentials, no `latest`, production-only dependencies, the CA variable, no dev tools) with controls, plus defect injection on the real file.
5. The new job is added to `.github/rulesets/main.json` as a required check (you import the ruleset; I only change the file) and to `docs/ops/ci-cd.md`.

## What I will NOT touch

AWS (nothing applied, no credentials); application behaviour (the new command is the only application code); the production profile's values; the registry, OIDC roles and deploy workflows (that is FD-6); migration compatibility between image versions (FD-5); Terraform apply.

## Decisions (founder, 2026-10-09: all recommendations accepted)

1. **Two PRs, command first (recommended)**, or one. Two keeps each review small and lets the rehearsal in PR 2 use a merged command.
2. **New dependency `@aws-sdk/client-secrets-manager`** (accept, recommended), or a person pastes the three connection strings into the console, which puts passwords through a human and a clipboard.
3. **The RDS CA bundle hash.** The founder's reply confirmed the numbers but did not say they were fetched independently of the sandbox's proxy, so PR 2 asks again before pinning. To confirm, run this on **your own machine** (not through this sandbox) and tell me the two numbers: `curl -sSfL https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem | tee bundle.pem | sha256sum` and `grep -c 'BEGIN CERTIFICATE' bundle.pem`. Mine were SHA-256 `fe45bbeb…395c` and 111 certificates. I will not pin a hash I could not independently confirm; PR 2 waits for your answer, PR 1 does not.
4. **Vulnerability scan: block on critical/high that have a fix (recommended)**, or report only for now.
5. **Image signing**: SBOM and provenance now; keyless signing later (its public log records the repository name and commit ids, which I would not publish without your say). Agree?
6. **Staging rehearsal uses the synthetic profile; production unchanged.** No decision needed; stated so it is on record.

## How I will verify

Lint, typecheck, build, `test:infra`, `test:ci-config`, `terraform fmt`/`validate`/`test`, all three backend tiers for PR 1 (it changes application code), defect injection with a green control for the command and for the Dockerfile guard, and for PR 2 the container rehearsal in CI. **Unverified until real AWS exists:** RDS behaviour (grants, `rds_superuser`), every IAM permission, Fargate with a read-only root and a missing `/tmp`, and cost.

## Order and effort

PR 1, then PR 2 (several CI iterations expected, because I cannot build the image here). Then FD-5 (migration compatibility and the first-deployment runbook).

## What PR 1 changed from the plan (found while building)

- **The migrator is not `CREATEROLE`.** The plan said it would be; the tested path (`ledger-migration.pg-spec.ts`) shows the privilege groups only need to exist and the migrator needs `SET` on two of them, so the command pre-creates the groups (same attributes as the migrations, kept in agreement by a test) and the migrator needs no role-creating right. It owns the database instead, so it can grant on `public`.
- **Passwords go to the database as SCRAM verifiers**, not plaintext: the RDS parameter group sets `log_statement = ddl`, and a plaintext `CREATE ROLE ... PASSWORD` would be written to the log. Checked on a cluster with that setting: the log holds only the verifier.
- **The task role can read the three secrets it writes** (to recognise an unchanged login), not only write them; it still cannot read the administrator secret.
- **A wrong secret id surfaces on the write**, not the read (Secrets Manager answers "not found" for both a missing secret and an empty container), so the command stops before changing any role.
- The development cluster (`scripts/dev-postgres.sh`) uses `trust` authentication, so two tests that expect a wrong password to be refused announce a skip there and **fail in CI if the cluster does not check passwords**.
