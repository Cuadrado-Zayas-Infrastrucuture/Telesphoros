# Terraform: database and storage (NOT APPLIED)

> **Status: written and validated, never applied.**
> Do **not** run `terraform apply` until **all** of these are true:
> 1. The AWS **BAA is executed** for the target account (AWS Artifact), and you hold the signed copy.
> 2. A **remote state backend** is configured (encrypted S3 bucket with locking, restricted access).
> 3. A human has reviewed `terraform plan` output line by line.
>
> Until then the product runs on synthetic data only, and nothing here exists in AWS.

## What it would create

| Piece | Detail |
| --- | --- |
| Database | RDS PostgreSQL 16: encrypted (customer-managed KMS key), private only, SSL forced, Multi-AZ (required in production), deletion protection, admin password generated and rotated in Secrets Manager (never in code or state), 14-day point-in-time recovery, automated backups **replicated to a second region** |
| Report files | S3 bucket: KMS-encrypted, versioned, all public access blocked, TLS 1.2+ only, access logging, CORS for direct browser uploads from your origins only, abandoned uploads cleaned up |
| Logical backups | (production profile only) S3 bucket in the **backup region** with its **own key**: Object Lock (nobody can delete or overwrite for 14 days), encryption with our key enforced, aged to cheaper storage, expires after a year |
| Audit trail | CloudTrail (multi-region, signed digests, S3 data events on the reports bucket), a locked log bucket with its own KMS key, and six email alarms ([audit-trail.md](../../docs/ops/audit-trail.md)) |
| Access | Two **unattached** IAM policies: `app_runtime` (read/write report files) and `backup_job` (write-only to the backup bucket) |

It does **not** create: the VPC and subnets, the image registry and image, DNS records, the database roles
(the privilege roles are created by the migrations and the three logins by `db provision-logins`, run as a one-off task: [api-hosting.md](../../docs/ops/api-hosting.md#the-database-logins-db-provision-logins)), dashboards, or the application's own alarms (the audit-trail alarms are the only ones; Phase 7/10).

**F3a optional API edge:** `api-edge.tf` adds an ACM certificate, an HTTPS-only load balancer, a firewall (WAF) and exact security
groups when `enable_api_hosting = true` (default false). **F3b compute** (`api-compute.tf`, same switch): ECS Fargate cluster and service, task and
migration task definitions, roles, secret containers (never values), a log group, and four alarms; the task definitions and service also need `api_image`.
See [api-hosting.md](../../docs/ops/api-hosting.md).

**H1 optional frontend:** `web.tf` now adds a private public-code S3 bucket, CloudFront/OAC and an ACM certificate
when `enable_web_hosting = true`. Its default is false: no new hosting resources are selected by default.
It still does not create DNS records, API compute, deployment roles/workflows or observability resources.
The entire root remains subject to the three first-apply gates above; enabling one option does not approve
creating the existing database/auth resources. Read the [hosting/DNS checklist](../../docs/ops/domains-and-hosting.md).

## How to use it later

```bash
cd infrastructure/terraform
cp example.tfvars.example production.tfvars   # fill in; *.tfvars is gitignored
terraform init
terraform validate && terraform plan -var-file=production.tfvars   # review!
terraform apply -var-file=production.tfvars                        # only after the three conditions above
```

Commit the generated `.terraform.lock.hcl` (run `terraform providers lock -platform=linux_amd64 -platform=darwin_arm64`).

## Deployment profiles (FD-3)

`deployment_profile` chooses the shape of the same root. **`production` is the default**, so a forgotten variable can never select the other one.

| | `production` (default) | `synthetic` (rehearsal only) |
| --- | --- | --- |
| Allowed with | `staging` or `production` | **`staging` only** (refused for `production`) |
| Regions | two: primary, plus the off-site backup key, locked backups bucket and replicated automated backups | **one**: none of those exist; the audit trail is single-Region |
| Database | `db_instance_class`, Multi-AZ (required in production), deletion protection, final snapshot, 14-day recovery window (variables) | `db.t4g.micro`, single-AZ, no deletion protection, no final snapshot, **1-day** recovery window, no Performance Insights |
| Network | you supply `vpc_id`, `private_subnet_ids` (and `public_subnet_ids` for hosting); refused if missing | **created** (`network-synthetic.tf`): a VPC, two public subnets in two zones, an internet gateway, the free S3 gateway endpoint. **No NAT gateway.** Tasks get a public address; the security groups are unchanged (port 3000 from the load balancer only; out only to the database and over HTTPS) and the database has no public address. Supply `vpc_id` and subnets to use your own instead (tasks then stay private) |
| Destroying | protected: `force_destroy = false`, 30-day key and secret recovery windows, Cognito deletion protection on | `force_destroy = true` on the buckets, 7-day key window, secrets deleted at once, Cognito deletion protection off, audit lock 1 day |
| Refused | | `COMPLIANCE` locks (nobody could ever remove them, so the rehearsal could not be destroyed) |

Every relaxation is written once, in `profile.tf`, and a guard test (`profile.guard.test.mjs`) lists each place the rest of the root consults it, so a new
one cannot slip in. The synthetic profile holds **synthetic data only** and is not a staging environment for real records.

### Running a synthetic rehearsal and destroying it

```bash
cd infrastructure/terraform
cp example.tfvars.example synthetic.tfvars   # *.tfvars is gitignored; set deployment_profile = "synthetic", environment = "staging", and leave vpc_id out
terraform init
terraform plan -var-file=synthetic.tfvars    # review it line by line, as for any plan
# apply and destroy are the FD-7 rehearsal; they need the gates in the status page (a founder-run session, a budget alert, a plan for the free window)
terraform destroy -var-file=synthetic.tfvars
```

**Before a destroy:** the identity that runs it needs `s3:BypassGovernanceRetention` (and `s3:DeleteObjectVersion`) on the three buckets, because a locked object less
than a day old can only be removed with the bypass header, and `force_destroy` uses it. Whether the provider really removes locked versions on destroy is **not yet
verified**; FD-7 tests it with a real destroy, and if it does not, the runbook gains a short emptying step. Things a destroy can leave behind: the RDS log
groups that AWS creates by itself (`/aws/rds/instance/...`) (check the console after the first real destroy).

**Resource addresses changed.** The off-site resources are now counted (`aws_kms_key.backup[0]`, `aws_s3_bucket.backups[0]`, and so on), as are the two API execution
policy documents. Nothing has ever been applied, so there is no state to move and no `moved` blocks are needed; if you hold a local test state or an old saved plan from before FD-3, discard it.

### What `terraform test` proves, and what it does not

`terraform test` (CI runs it in the `terraform` job; no credentials) plans the whole root offline under each profile with every provider mocked: that the default variables plan,
what each profile creates and switches off, and that the refusals refuse (`profiles.tftest.hcl`). It proves the **shape**. It does **not** prove that AWS accepts it (quotas, the
free plan's limits, a service it refuses, whether the provider can destroy locked objects): that is the first real apply. A new `mock_data` default is needed for any new data source.

## What was verified (and what was not)

Original verification used AWS provider 5.100.0; the requirement has since advanced. Since FD-3 CI also runs `terraform test` (an offline, mocked plan per deployment profile; see above). H1 formatting/schema
validation and exact current provider versions are recorded in [H1 verification](../../docs/verification/hosting-h1.md).
**Not verified:** `terraform plan` or `apply` (no AWS credentials were
used), real RDS point-in-time recovery, cross-region replication, and Object Lock behaviour. Treat the recovery
objectives for the managed database as **unproven** until a restore drill has been run in AWS.

## Connecting the API

| API setting | From |
| --- | --- |
| `REPORTS_BUCKET` | output `reports_bucket` |
| `AWS_REGION` | `region` |
| `DATABASE_URL` | the **application** login role (never the admin user), host from output `db_endpoint`, `DATABASE_SSL=require` |
| `DATABASE_MIGRATOR_URL` / `DATABASE_ADMIN_URL` | admin credentials from the secret in `db_master_secret_arn` (migrations and backups only) |

## Authentication (Cognito) and the password-change notifier

`cognito.tf` and `lambda.tf` add: an **invite-only** user pool (MFA required, authenticator app only, 14-character
passwords, email-only recovery), the `reader`/`clinician`/`admin` groups (tenant groups, `tenant:<id>`, are created per organization by the runbook in `docs/auth.md`, not here), a **public** browser client (authorization
code + PKCE, 15-minute tokens, revocation on, no user-enumeration hints), the sign-in domain, an SES sender, and the
Lambda that emails the owner when a password is reset. Build the Lambda first:

```bash
pnpm --filter @telesphoros/password-change-notifier build   # produces infrastructure/lambda/password-change-notifier/dist
```

Extra inputs: `app_callback_urls`, `app_logout_urls`, `cognito_domain_prefix`, `ses_from_email` (see
`example.tfvars.example`). SES starts in its **sandbox**; request production access before inviting real people.

| Setting | From (output) |
| --- | --- |
| API `COGNITO_REGION`, `COGNITO_USER_POOL_ID`, `COGNITO_APP_CLIENT_ID` | the region, `cognito_user_pool_id`, `cognito_app_client_id` |
| Frontend `VITE_OIDC_AUTHORITY`, `VITE_OIDC_CLIENT_ID`, `VITE_COGNITO_DOMAIN` | `cognito_issuer`, `cognito_app_client_id`, `cognito_sign_in_domain` |

A guard test (`node --test infrastructure/terraform/guard.test.mjs`, or `pnpm test:infra`) fails if someone weakens
MFA, invite-only, password rules, token lifetimes or the client's flows. Details, runbook and the first-apply checklist:
[docs/auth.md](../../docs/auth.md).
