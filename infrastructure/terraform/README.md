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
| Access | Two **unattached** IAM policies: `app_runtime` (read/write report files) and `backup_job` (write-only to the backup bucket) |

It does **not** create: the VPC and subnets, the application compute, DNS and certificates, the database roles
(`telesphoros_app` and its login user are created by migrations plus an operator step), alarms or dashboards (Phase 7/10).

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

Verified: `terraform fmt -check`, `terraform validate` against the real AWS provider schema (5.100.0), and that
`validate` fails on a deliberately broken file. **Not verified:** `terraform plan` or `apply` (no AWS credentials were
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
passwords, email-only recovery), the `reader`/`clinician`/`admin` groups, a **public** browser client (authorization
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
