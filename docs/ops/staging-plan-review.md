# Reviewing the staged synthetic plans (FD-7 slice 4)

**Status: the example variables and this checklist exist. Nothing has been planned or applied against AWS.** Synthetic data only. Plan: [fd7-staged-synthetic-deploy.md](../design/plans/fd7-staged-synthetic-deploy.md).
This page is what the first real `terraform plan` of the staged environment must and must not contain, drawn from the offline plans in `infrastructure/terraform/staging.tftest.hcl`
(the same values as `synthetic-staging.tfvars.example`; a guard keeps the two equal). **Reading a plan is not approval to apply:** the first-apply gates in `infrastructure/terraform/README.md`
(BAA position, remote state, this review) and the founder's yes to the plan and its cost still stand, and decisions D1 (account and Region) and D2 (budget ceiling) must be settled first.

## What the offline plans cannot show

They run with every provider mocked. They prove the **shape**: what exists, what is off, what is refused. They do **not** show names and addresses that AWS assigns, account limits and quotas, anything the free plan refuses,
whether a service is available in the Region, the certificate waits, or **cost** (no estimate has been made; price the billable items below against the account's own price list). The first real plan and apply will find what the mocks accepted
and AWS refuses; each such failure is recorded, not hidden.

## Before the first plan

1. Copy `infrastructure/terraform/synthetic-staging.tfvars.example` to a file **outside version control** (`*.tfvars` is gitignored) and replace the three `PLACEHOLDER` lines:
   `cognito_domain_prefix` (globally unique in the Region), `ses_from_email` (verified in SES; the sandbox only delivers to verified addresses) and `alarm_email` (an inbox a person reads; it must not still be `@example.com`).
2. Check the hostnames. `web_domain` is a **base domain**: the app is `app.<web_domain>`. `api_domain` is **not** derived from it, and the web page's policy allows exactly `api.<web_domain>`: if they disagree the browser blocks every API call.
   The example sets `api.staging.telesphoros.app`; a guard fails the build if the example drifts.
3. `terraform init` against the remote state (a separate approved change; it does not exist yet), and `aws sts get-caller-identity`: the account and the Region are the ones decided in D1.
4. Leave `region` at its default until D1 confirms it. Do not add `vpc_id`, subnets or `app_security_group_ids` (the synthetic profile creates the network), and do not set `api_image` until the image exists ([image-push.md](image-push.md)).

## The three plans

There is no plan with both hosting switches off. With the profile's own network the database can only name the API tasks' security group, which exists only when API hosting is on; the module refuses to plan the database otherwise
(`database.tf` precondition). So the first plan already includes the API edge, and its apply waits for the API certificate's validation CNAME.

| Plan | Command | Adds, offline | Waits for |
| --- | --- | --- | --- |
| A. foundations and API edge | `terraform plan -var-file=<yours> -var enable_web_hosting=false -out=a.tfplan` | 132 | API certificate: a DNS-only validation CNAME in Cloudflare |
| B. plus web hosting | `terraform plan -var-file=<yours> -out=b.tfplan` | 12 more (144) | web certificate: a validation CNAME |
| C. with the image | `terraform plan -var-file=<yours> -var 'api_image=<repository url>@sha256:<64 hex>' -out=c.tfplan` | 9 more (153) | nothing |

The counts are the offline plan of the commit that wrote this page; the root keeps growing, so compare the **shape** below and investigate a large difference, not a small one.
Once the image registry is merged, plan A also adds the registry and its retention policy ([image-push.md](image-push.md)). Read each plan as text: `terraform show a.tfplan > a.txt`.

For plan A the first apply is **create-only**: `Plan: N to add, 0 to change, 0 to destroy.` Plans B and C against the state left by the one before must be create-only too. Any `change`, `destroy` or `replace` in these steps is a stop.

### Quick checks (each must print nothing)

```sh
grep -nE 'aws_nat_gateway|aws_eip|aws_default_vpc|aws_default_subnet' a.txt b.txt c.txt   # no NAT, no elastic address, never the default VPC
grep -nE 'secret_version|secret_string|secret_binary' a.txt b.txt c.txt                    # secret VALUES are never in Terraform
grep -nE 'publicly_accessible +\= true' a.txt b.txt c.txt                                  # the database is private
grep -nE 'will be (destroyed|replaced|updated)|must be replaced' a.txt b.txt c.txt         # create-only
grep -nE 'aws_s3_bucket\.backups|aws_kms_key\.backup|automated_backups_replication' a.txt  # the second-Region backups do not exist in the synthetic profile
```

## What plan A must contain

| Area | Must be there | Why it matters |
| --- | --- | --- |
| Profile | output `deployment_profile = "synthetic"`; `environment = "staging"` in the tags | the relaxations below are valid only here |
| Network | 1 VPC, 2 subnets, 1 internet gateway, 1 route table with one default route, 1 gateway endpoint for S3; the default security group with **no** rules | no NAT (it costs every hour); tasks reach the registry through a public address |
| Database | `db.t4g.micro`, single-AZ, `storage_encrypted = true`, `publicly_accessible = false`, `manage_master_user_password = true`, 20 GB growing to 100, 1 day of backups, `deletion_protection = false`, `skip_final_snapshot = true` | the relaxed values are **expected here and nowhere else**; the master password is generated and held by RDS, never in Terraform |
| Security groups | ingress rules exactly: 443 from `0.0.0.0/0` on the load balancer's group only; 3000 to the tasks from the load balancer's group; 5432 to the database from the API tasks' group; 5432 from the worker's group | any other ingress, and any `0.0.0.0/0` besides the first, is a stop |
| Buckets | 3: reports, audit, access-logs, each with a public-access block, encryption and ownership controls; `force_destroy = true`; the audit bucket with Object Lock **GOVERNANCE, 1 day** | `COMPLIANCE` is irreversible and is refused by the profile |
| Keys | 4 KMS keys (data, audit, API logs, worker logs), deletion window 7 days | short window so a destroy completes |
| Secrets | 6 secret **containers** (3 database logins, the worker login, the invitation key, the identifier key) with `recovery_window_in_days = 0`; no secret versions | values are filled by hand and by `provision-logins` ([staging-rehearsal.md](staging-rehearsal.md)) |
| Sign-in | 1 user pool (MFA on, admin-create-only, no SMS), 1 browser client, 1 sign-in domain, 4 groups, `deletion_protection = INACTIVE`; 1 SES identity; 1 Lambda for password notices | invite-only; the SES identity sends a verification email when applied |
| Audit | 1 trail, **single-Region** (`is_multi_region_trail = false`), 11 log metric filters and 11 alarms, 1 SNS topic and its email subscription | the subscription must be confirmed by the owner or no alarm reaches anyone |
| API edge | 1 load balancer (HTTPS 443 only, no port-80 listener), 1 listener, 1 rule, 1 target group, 1 certificate and its validation, 1 firewall (WAF) and its association, 1 cluster, 1 log group | the certificate validation blocks the apply until the CNAME exists |
| Services | **none**: no task definitions, no services | they need `api_image` |

## What plan B adds (12)

The web bucket (public-access block, ownership controls, versioning, encryption, policy), the web certificate and its validation, the CloudFront distribution, its function, response-headers policy and origin access control.
Check: aliases are `app.<web_domain>`, `<web_domain>` and `www.<web_domain>`; the distribution has **no** custom error response that turns a 403 or 404 into a 200; the bucket policy lets only this distribution read and denies plain HTTP.

## What plan C adds (9)

2 services (API and worker, `desired_count = 1` each), 4 task definitions (API, migration, provisioning, worker), 3 alarms (running tasks, unhealthy targets, 5xx).
Check in every task definition: the image is `...@sha256:<64 hex>` (never a tag), `readonlyRootFilesystem = true`, user `10001`, `DATABASE_SSL = require`, no secret in `environment` (secrets come from `secrets` with ARNs), and the migration task has **no task role**.
Tasks and services get a **public address** here (`assign_public_ip = true`) because the synthetic network has no NAT; that is expected in the synthetic profile only.
**Setting `api_image` starts the services at once**, before the logins and the schema exist, so they will fail until the one-off steps are done: that is expected and described in [staging-rehearsal.md](staging-rehearsal.md).

## Stop and ask when

- anything is destroyed, replaced or changed in a plan that should only create;
- a relaxation (`force_destroy`, no deletion protection, a 7-day key window, `recovery_window_in_days = 0`, a public task address) appears for a resource that is not in the tables above, or `deployment_profile` is not `synthetic`;
- a resource named in the quick checks appears; a second Region, a backups bucket or a CloudTrail trail that is multi-Region appears;
- a value that should be known is `(known after apply)` and the table says it is a literal (bucket names contain the account id, which the offline plan replaces with a random string, so read the real plan's names for the account you decided in D1);
- a quota, a free-plan restriction or a missing service is reported: record it in the plan's risks and do not work around it silently.

## Billable items to price before D2

RDS instance and storage; the load balancer; the firewall (web ACL and rules, plus per-request charges); CloudFront; Fargate tasks (two services, plus the one-off tasks) and **public IPv4 addresses** on them and on the load balancer
(check the account's current rate: it applies per address per hour); 4 KMS keys; 6 secrets; CloudTrail, CloudWatch logs and 14 alarms; ECR storage; the S3 gateway endpoint has no hourly charge. Nothing here has been priced.

## After the review

Record who reviewed which plan file (`sha256sum a.tfplan`), the commit, and the answer to D2. Apply only the plan that was reviewed (`terraform apply a.tfplan`), one stage at a time, in a founder-run session, and stop and look after each.
