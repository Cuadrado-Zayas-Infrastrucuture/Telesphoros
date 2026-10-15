# Plan FD-7: a staged synthetic deployment in AWS

Status: **founder approved the direction and D1 to D3 on 2026-10-15 and asked to start Phase 1 (see "Decisions recorded"); the per-slice plans are below and each slice still needs its own go before code. Draft otherwise for founder approval. Nothing is applied, published or changed by this document.** Requested 2026-10-15 ("wire Telesphoros app to go live"); narrowed with the founder to a **staged environment with synthetic data only**. A real production launch with patient data is a separate plan and is blocked (see "What this is not").

## Why

Everything needed to describe a running system is written and tested offline: Terraform for the database, storage, Cognito, API edge and compute, web hosting and worker; a `synthetic` deployment profile (FD-3); the provisioning command (FD-4a); the image and its CI rehearsal (FD-4b). **None of it has met AWS.** The repository lists what only a real account can show: that AWS accepts the whole root, quotas and free-plan limits, certificate validation, the live CloudFront/Cognito/S3 path and CSP, task-to-database reachability, secret injection, the alarms actually firing, the worker in Fargate, and whether locked objects can be destroyed. This plan is the first real contact, under conditions where being wrong costs a rebuild and not a breach.

## What this is not

- **Not production, and not real data.** The AWS BAA is not executed, so no real patient information goes in, ever. The environment is for named synthetic testers.
- **Not clinical.** Clinical processing stays disabled; the lab-report pipeline stays off (`LAB_REPORT_PIPELINE` default). Every disclaimer in the product stays.
- **Not a production cutover.** No production DNS change, no apex or `www` redirect, no change to the company site on Vercel.
- **Not a pipeline.** No GitHub-to-AWS role or deploy workflow is created here; the rehearsal is run by a person (decision D4).

## The environment

One Region; `deployment_profile = "synthetic"`, `environment = "staging"` (the profile refuses any other combination). It creates its own small VPC (two public subnets, no NAT gateway), single-AZ `db.t4g.micro` RDS, the reports bucket, Cognito (invite-only, MFA), the audit trail (single Region), API edge and Fargate compute, the worker, and the web bucket with CloudFront. Production protections are deliberately relaxed so it can be destroyed (`force_destroy`, short key windows, no deletion protection), and the profile check refuses the same relaxations on production.

## Phase 0: prerequisites (people, not code)

1. **Account and window.** The AWS account is on a free plan with a closing date (about 9 April 2027, per the FD-3 plan). Confirm the account, the Region and that the window is enough to apply, test and destroy.
2. **Budget alert and a ceiling** set in the account before any apply.
3. **Remote state:** an encrypted, locked S3 backend for Terraform state, created as its own small, separately approved change (the Terraform README's second gate; it does not exist yet).
4. **Who applies:** a founder-run session on an MFA-protected identity with the permissions the plan needs, including `s3:BypassGovernanceRetention` and `s3:DeleteObjectVersion` for the destroy.
5. **DNS access:** Jan adds Cloudflare records as the apply waits (certificate validation CNAMEs, then DNS-only CNAMEs for the app and API names). Existing Google mail records stay untouched.
6. **SES sandbox:** verified sender and tester addresses (invitations and password-reset mail will not reach anyone else while SES is in the sandbox).
7. **Hostnames** (decision D3).

## Phase 1: build what is missing (each its own slice and draft PR, plan first)

Found by reading the existing docs; confirm each against the code before building.

1. **Image registry and push runbook.** The Terraform README says it does not create the registry or the image. Add a registry under the synthetic profile (guard-tested like the rest), and a runbook to build, scan and push the FD-4b image **by digest**.
2. **Frontend publish runbook.** Build with the real Cognito values and `VITE_API_BASE_URL=https://<api host>`, exclude `*.map` from the public upload, upload to the web bucket, invalidate CloudFront. The H1 doc says no upload script, release workflow or artifact is supplied. Runs from a person's shell, not a pipeline.
3. **Operator one-off tasks.** Provisioning logins and migrations have task definitions. Seeding organizations and invited members (`tenant create`, `membership grant`, per `docs/ops/membership.md`) must also run as a one-off task with the migration login because RDS is private; confirm a task definition or runbook exists and add the missing piece.
4. **A staged `synthetic.tfvars` example** and a line-by-line plan-review checklist for this specific root.

None of this changes application behavior, production values or any existing guard.

## Phase 2: apply, in the documented order (founder-run; stop and look after each step)

Order follows `api-hosting.md` ("Before the first apply") and `domains-and-hosting.md`, adapted for the synthetic profile (own VPC, no NAT).

1. `terraform init` against the remote state; `plan` with hosting switches off; **review the plan line by line**; apply the foundations (network, keys, database, buckets, Cognito, audit trail).
2. Enable web and API hosting; apply; Jan adds the certificate validation CNAMEs while the apply waits.
3. Set the two hand-made secrets (`INVITATION_DIGEST_KEY`, `IDENTIFIER_DIGEST_KEY`, each from `openssl rand -hex 32`); run the **provision-logins** task; run the **migration** task; seed one or two synthetic organizations and the synthetic testers' memberships.
4. Build, scan and push the image by digest; set `api_image`, `api_cors_origins` and `api_desired_count`; apply again; the worker comes up from the same image.
5. Publish the frontend. Only after a healthy API is behind it: Jan adds the DNS-only CNAMEs for the app and API names.

## Phase 3: acceptance, synthetic data only

Everything below is already written in the repo as unchecked lists; this plan makes them the exit criteria and records what actually happened, including failures.

- **Edge and web** (`domains-and-hosting.md` step 6): TLS, headers and the live CSP, BrowserRouter deep links, callback and logout, API CORS, upload through the API, denied direct S3 access, missing-asset errors, apex/www behavior where configured.
- **API** (`api-hosting.md` items 6 and 7): TLS 1.2 accepted and 1.1 refused, port 80 refused, `/` 404, `/api/v1/health` and `/ready`, a firewall block, the unhealthy-target path, **every alarm** fired with `set-alarm-state`, and the `ledger-compromised` line produced for real in a throwaway tenant.
- **Auth** (`auth.md` first-apply checklist): token claims, ID token refused, a member with no row gets 403, MFA forced, invitation and reset mail arrive, sign-out, CORS origin.
- **Worker:** heartbeat and `queue-stats` lines, the four worker alarms, a stored-file check against a real uploaded synthetic file.
- **Destroy test:** `terraform destroy`, including whether the provider removes locked object versions (unverified today); list anything left behind (for example RDS log groups).
- **Optional:** a point-in-time recovery drill (the recovery objectives are unproven until one is run).

## Phase 4: teardown or keep (decision D8)

Default is destroy after the evidence is recorded, restoring the saved DNS state; certificate validation and mail records are not removed as part of a rollback.

## Decisions only the founder can make

- **D1. Account, Region and window.** Which AWS account and Region; confirm the free-plan window covers apply, test and destroy.
- **D2. Budget ceiling and alert.** A number you are comfortable with. I will not guess a cost; the first reviewed `plan` plus the account's own pricing gives the estimate, and the apply waits on your yes to it.
- **D3. Hostnames.** Use the real names or separate staging names. Recommended and approved: **separate staging names**, under the module's base-domain rule: `web_domain = staging.telesphoros.app` (see "Decisions recorded").
- **D4. Who applies, and how.** Recommended: **a founder-run session** with scripts from Phase 1, not a GitHub OIDC pipeline. A pipeline is built after the rehearsal has shown what the steps really are.
- **D5. Image registry.** Recommended: add it to Terraform under the synthetic profile and push by digest.
- **D6. Testers.** Which named people get invitations, and the addresses verified in the SES sandbox. They are told synthetic data only.
- **D7. Remote state.** Confirm creating the encrypted, locked state bucket as a separate approved change first.
- **D8. After the rehearsal.** Destroy (recommended) or keep the environment for demos.

## Decisions recorded (founder, 2026-10-15: "approve D1 through D3 and start Phase 1")

- **D1 (account and Region): approved in principle; the values are still needed.** Phase 1 needs neither. Phase 0 and Phase 2 do: the founder supplies the AWS account and the Region (and confirms the free-plan window) before any apply.
- **D2 (budget ceiling): approved in principle; the number is still needed.** No apply happens without a stated ceiling and a budget alert in the account.
- **D3 (hostnames): approved as "separate staging names", with a correction to what the plan first suggested.** Reading `web.tf` shows `web_domain` is a **base domain**: the app host is always `app.<web_domain>`, the API host the CSP allows is `api.<web_domain>`, and the apex and `www.<web_domain>` are redirects (all four are on the certificate). The earlier suggestion `app-staging.telesphoros.app` is therefore not possible without changing the module. The achievable convention is `web_domain = "staging.telesphoros.app"`, giving `app.staging.telesphoros.app` and `api.staging.telesphoros.app` (and `api_domain = "api.staging.telesphoros.app"`, which must match). Jan adds those records, DNS-only, in the existing Cloudflare zone.

## Phase 1 slice plans

Order: 1, 2, 3, 4. Each is its own pull request, branched off `main`, never stacked, opened as a draft, and the work stops after each for review (STATUS working agreements 1 to 3). Findings below come from reading the code on `main`; every Terraform change keeps the offline `terraform test`, the guard tests and `pnpm test:infra` green. **No slice uses an AWS credential, applies anything, or costs anything.**

### Slice 1: image registry and push runbook

- **Found:** no registry resource exists anywhere in Terraform, yet `api_image` is validated as `<account>.dkr.ecr.<region>.amazonaws.com/<repo>@sha256:<digest>` and the task execution roles derive their pull permission from that repository. Today there is nowhere to push.
- **Touches:** a new `aws_ecr_repository` gated by `enable_api_hosting` (immutable tags, scan on push, a lifecycle rule keeping the last 10 images, `force_delete` only under the `synthetic` profile so a destroy works), an output with its URL, guard tests and `terraform test` cases (default variables create none; synthetic with hosting creates one), and a runbook `docs/ops/image-push.md`: build the FD-4b image, log in, push, resolve the **digest**, set `api_image`, and the documented order (apply the foundations first, then push, then set `api_image`).
- **Does not touch:** the Dockerfile and the image contents, the CI `image` job, task definitions, IAM, production values, the existing guards.
- **Founder decisions:** encryption (recommended: AWS-managed AES-256; a customer-managed key would also need decrypt grants on both execution roles), retention (recommended: last 10).
- **Verification:** `terraform fmt`, `validate`, `terraform test`, guard tests with injected defects (a mutable-tag copy, a missing `force_delete` gate, an ungated repository), `pnpm test:infra`.

### Slice 2: frontend publish

- **Found:** `vite.config.ts` has `sourcemap: true`, so a naive upload would publish source maps (the H1 doc forbids it); `web.tf` exposes the bucket and the CloudFront domain but **no distribution id**, which an invalidation needs; no publish script exists.
- **Touches:** a `web_distribution_id` output, `scripts/staging/publish-frontend.sh` and its test, and `docs/ops/frontend-publish.md`. The script defaults to a dry run that prints what it would do; it requires the four `VITE_*` values and the bucket and distribution (https only, refuses placeholder or empty values), builds the normal production frontend, **refuses to continue if any `*.map` is in the upload set**, syncs, and invalidates. It runs from a person's shell.
- **Does not touch:** application code, the CSP, CloudFront routing, IAM, any AWS resource.
- **Open product point (not part of this slice):** the repository's capability matrix says the Reports dashboard (`/reports`) is mounted only in the owned-storage build, which is restricted to a loopback address. A hosted build therefore has upload but **no Reports dashboard**. Changing that is a separate, explicitly approved product intention, so the staged environment will show the upload page and not the dashboard until then.
- **Verification:** a Node test that runs the script in dry-run mode against good and bad environments (missing value, `http://`, placeholder, a stray `.map`), shell syntax check, `pnpm test:infra`.

### Slice 3: one-off task runner and runbook

- **Found:** the migration task definition already runs `node dist/db/cli.js ...` with only the migrator secret and no task role, and the operator commands for organizations and members (`tenant create`, `membership grant`) are in the same CLI. So seeding can reuse that task with a command override and **needs no new task definition or IAM**. What is missing is the network input: the API outputs give the cluster, the task families and the tasks' security group, but not the subnets, and under the `synthetic` profile tasks have no NAT and need a public address to pull the image.
- **Touches:** an output for the task subnets, `scripts/staging/run-task.sh` and its test (dry run by default, `--yes` to execute; subcommands `migrate`, `provision-logins`, `tenant-create`, `membership-grant`; validates ids, roles and flags against the CLI's own patterns, refuses shell metacharacters, sets `assignPublicIp` correctly for the synthetic profile), and `docs/ops/staging-rehearsal.md` with the exact order, where the logs are, and what each step must print.
- **Does not touch:** task definitions, roles, secrets, the CLI's behavior.
- **Verification:** Node tests over the printed command shape and every refusal, shell syntax check, `pnpm test:infra`.

### Slice 4: staged variables and plan-review checklist

- **Touches:** `infrastructure/terraform/synthetic-staging.tfvars.example` (placeholders only, using the D3 convention, `deployment_profile = "synthetic"`, `environment = "staging"`, hosting switches, callbacks and CORS origins that satisfy the module's own precondition), `docs/ops/staging-plan-review.md` (a line-by-line list of what the first `terraform plan` must and must not contain, drawn from the offline test shapes: no NAT, no public database, secrets without values, relaxations only under `synthetic`, counts), and a test that the example's required values plan offline.
- **Does not touch:** `example.tfvars.example`, any default, any guard.
- **Verification:** `terraform test` with the example's values, `pnpm test:infra`.

## Risks and open points

- **AWS may refuse something the mocks accepted** (quotas, a free-plan limit, a service). The first plan and apply will find it; each failure is recorded, not hidden.
- **Cost is unknown here.** Nothing runs until D2 is answered; a budget alert exists before the first apply.
- **A public staging URL invites misuse.** Mitigations: invite-only sign-in with MFA, no real data policy stated on the page, clinical processing and the lab pipeline off, development-only routes excluded from the production build (existing guards), and no search-engine promotion.
- **The live CSP, CORS and cookie-less browser path** were never run against real CloudFront, Cognito or S3; expect adjustments.
- **SES sandbox** limits who can be invited.
- **Locked-object destroy** is unverified; the runbook may need an emptying step.
- **The closing date** shortens the available window; a failed first attempt may not leave time for a second.

## What it does not touch

Production values and profile; the BAA decision; application behavior except the four small Phase 1 slices; Cognito MFA and password rules; audit and key policies; the company site and its Vercel project; any real data. No AWS credential is used and nothing is applied by this plan or its PR.

## Verification of this plan

Documentation only. Every statement about existing behavior comes from the repository documents named above (`infrastructure/terraform/README.md`, `docs/ops/api-hosting.md`, `docs/ops/domains-and-hosting.md`, `docs/ops/deployment.md`, `docs/auth.md`, `docs/ops/membership.md`, `docs/design/plans/fd3-synthetic-profile.md`); the gaps in Phase 1 are what those documents say does not exist and still need confirming against the code. Nothing here is verified in AWS.
