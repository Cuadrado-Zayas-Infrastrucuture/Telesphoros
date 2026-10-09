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
| Logical backups | S3 bucket in the **backup region** with its **own key**: Object Lock (nobody can delete or overwrite for 14 days), encryption with our key enforced, aged to cheaper storage, expires after a year |
| Audit trail | CloudTrail (multi-region, signed digests, S3 data events on the reports bucket), a locked log bucket with its own KMS key, and six email alarms ([audit-trail.md](../../docs/ops/audit-trail.md)) |
| Access | Two **unattached** IAM policies: `app_runtime` (read/write report files) and `backup_job` (write-only to the backup bucket) |

It does **not** create: the VPC and subnets, the application compute, DNS records, the database roles
(`telesphoros_app` and its login user are created by migrations plus an operator step), dashboards, or the application's own alarms (the audit-trail alarms are the only ones; Phase 7/10).

**F3a optional API edge:** `api-edge.tf` adds an ACM certificate, an HTTPS-only load balancer, a firewall (WAF) and exact security
groups when `enable_api_hosting = true` (default false). The compute behind it is F3b. See [api-hosting.md](../../docs/ops/api-hosting.md).

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

## What was verified (and what was not)

Original verification used AWS provider 5.100.0; the requirement has since advanced. H1 formatting/schema
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
