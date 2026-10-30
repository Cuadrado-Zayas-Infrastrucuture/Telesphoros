# Reviewing the staged synthetic plans (FD-7 slice 4)

**Status: the example variables and this checklist exist; live AWS planning and acceptance remain unverified.** Synthetic data only. Plan: [fd7-staged-synthetic-deploy.md](../design/plans/fd7-staged-synthetic-deploy.md).
This page is what the first real `terraform plan` of the staged environment must and must not contain, drawn from the offline plans in `infrastructure/terraform/staging.tftest.hcl`
(the same values as `synthetic-staging.tfvars.example`; a guard keeps the two equal). **Reading a plan is not approval to apply:** the first-apply gates in `infrastructure/terraform/README.md`
(BAA position, remote state, this review) and the founder's yes to the plan and its cost still stand, and decisions D1 (account and Region) and D2 (budget ceiling) must be settled first.

The [readiness record](foundations-readiness.md) makes the BAA/manual-session issue
an explicit unresolved gate; no exception or AWS access is granted here. Establish
existing resource/state ownership privately after separately approved inventory.

## What the offline plans cannot show

They run with every provider mocked. They prove the **shape**: what exists, what is off, what is refused. They do **not** show names and addresses that AWS assigns, account limits and quotas, anything the free plan refuses,
whether a service is available in the Region, the certificate waits, or **cost** (no estimate has been made; price the billable items below against the account's own price list). The first real plan and apply will find what the mocks accepted
and AWS refuses; each such failure is recorded, not hidden.

## Before the first plan

1. Copy `infrastructure/terraform/synthetic-staging.tfvars.example` to a file **outside version control** (`*.tfvars` is gitignored) and replace the three `PLACEHOLDER` lines:
   `cognito_domain_prefix` (globally unique in the Region), `ses_from_email` (its domain becomes the SES identity, verified by the three `ses_dkim_records` CNAMEs after apply; the sandbox only delivers to verified addresses) and `alarm_email` (an inbox a person reads; it must not still be `@example.com`).
2. Check the hostnames. `web_domain` is a **base domain**: the app is `app.<web_domain>`. `api_domain` is **not** derived from it, and the web page's policy allows exactly `api.<web_domain>`: if they disagree the browser blocks every API call.
   The example sets `api.staging.telesphoros.app`; a guard fails the build if the example drifts.
3. Complete the separately authorized [backend activation and state-inventory gates](terraform-state.md#main-backend-configuration-source-only), then initialize with `terraform -chdir=infrastructure/terraform init -input=false -backend-config=backend.s3.tfbackend`. Main's partial S3 source wiring does not establish a live backend. Confirm the existing owner with `aws sts get-caller-identity`: the account and the Region are the ones decided in D1. Use only the approved synthetic state key and default workspace; no extra backend overrides.
4. Set `region` explicitly from the approved D1 value, even if it matches the default; do not run a live plan while D1 is pending. Do not add `vpc_id`, subnets or `app_security_group_ids` (the synthetic profile creates the network), and do not set `api_image` until the image exists ([image-push.md](image-push.md)).

## The three plans

There is no plan with both hosting switches off. With the profile's own network the database can only name the API tasks' security group, which exists only when API hosting is on; the module refuses to plan the database otherwise
(`database.tf` precondition). So the first plan already includes the API edge, and its apply waits for the API certificate's validation CNAME.

| Plan | Command | Adds, offline | Waits for |
| --- | --- | --- | --- |
| A. foundations and API edge | `terraform plan -var-file=<yours> -var enable_web_hosting=false -out=a.tfplan` | 132 | API certificate: a DNS-only validation CNAME in Cloudflare |
| B. plus web hosting | `terraform plan -var-file=<yours> -out=b.tfplan` | 12 more (144) | web certificate: a validation CNAME |
| C. with the image | `terraform plan -var-file=<yours> -var 'api_image=<repository url>@sha256:<64 hex>' -out=c.tfplan` | 9 more (153), plus 4 policy updates | nothing |

The counts are the offline plan of the commit that wrote this page; the root keeps growing, so compare the **shape** below and investigate a large difference, not a small one.
The merged image registry adds the registry and its retention policy to plan A ([image-push.md](image-push.md)). Read each plan as text: `terraform show a.tfplan > a.txt`.

Plan A against empty state and plan B against A's state are **create-only**: `Plan: N to add, 0 to change, 0 to destroy.` Plan C against B's state also updates the **four existing execution-role policies** listed below. Any other update, any deletion or any replacement is a stop. These are first-bring-up stages, not rules for later releases or an already running environment.

Before an image is set, API hosting already creates these policies with `PullThisRepositoryOnly.Resource` pointing to `arn:aws:ecr:<region>:<account>:repository/none`. C changes that one resource to the repository derived from the digest-pinned `api_image`:

- `aws_iam_role_policy.api_execution_service[0]`
- `aws_iam_role_policy.api_execution_migrate[0]`
- `aws_iam_role_policy.api_execution_provision[0]`
- `aws_iam_role_policy.worker_execution[0]`

In each policy, only that statement's `Resource` may change. The role, all actions, conditions and other statements must stay the same. No wildcard pull repository is permitted. The image must belong to the selected stack Region; a cross-account or other unexpected transition requires separate review.

Save JSON as well as text, with private file permissions; plan files can contain sensitive values. From the repository root, run the read-only action check against each **actual saved plan** after the preceding stage was applied:

```sh
umask 077
terraform -chdir=infrastructure/terraform show -json a.tfplan > infrastructure/terraform/.terraform/a.plan.json
node scripts/staging/check-plan.mjs A infrastructure/terraform/.terraform/a.plan.json
# Repeat with B/b.tfplan/b.plan.json and C/c.tfplan/c.plan.json at their respective stages.
```

Stage C also reads `infrastructure/terraform/.terraform/verified-image.json`, the record `scripts/staging/verify-image.mjs` writes next to the saved
plans ([image-push.md](image-push.md#before-setting-api_image-verify-the-signature)). It refuses the plan unless that record covers `api_image`, and
`api_migrate_image` when set. The signature must come from this stack's key, `alias/<name_prefix>-<environment>-image-signing`, or the record must be a
break-glass entry for synthetic staging. A break-glass entry is printed with its reason; production has none (INF-03, decision D3).

The check rejects unrelated updates, deletions, replacements, drift, incomplete plans and changes beyond the four exact repository transitions. It does not apply anything, approve the plan, validate every created resource or estimate cost; the tables and human line-by-line review still apply. Do not print or commit saved plan JSON.

Offline verification: `pnpm test:infra` checks the saved-plan action rules with synthetic before/after fixtures, including attempted permission expansion on every permitted policy address. `terraform test` checks the actual configured pull repositories before and after setting the image and that the four policies exist before C. Its independent empty-state plans and constant mocked policy JSON do **not** prove the A→B→C state transition or AWS's resulting plan; the saved-plan review remains required.

### Quick checks (each must print nothing)

```sh
grep -nE 'aws_nat_gateway|aws_eip|aws_default_vpc|aws_default_subnet' a.txt b.txt c.txt   # no NAT, no elastic address, never the default VPC
grep -nE 'secret_version|secret_string|secret_binary' a.txt b.txt c.txt                    # secret VALUES are never in Terraform
grep -nE 'publicly_accessible +\= true' a.txt b.txt c.txt                                  # the database is private
grep -nE 'will be (destroyed|replaced)|must be replaced' a.txt b.txt c.txt               # never destroy or replace
grep -nE 'will be updated' a.txt b.txt                                                   # A/B stay create-only; C uses check-plan.mjs
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
| Sign-in | 1 user pool (MFA on, admin-create-only, no SMS), 1 browser client, 1 sign-in domain, 4 groups, `deletion_protection = INACTIVE`; 1 SES identity; 1 Lambda for password notices | invite-only; the SES identity is the sender's domain and verifies once its three DKIM CNAMEs are in DNS |
| Audit | 1 trail, **single-Region** (`is_multi_region_trail = false`), 11 log metric filters and 11 alarms, 1 SNS topic and its email subscription | the subscription must be confirmed by the owner or no alarm reaches anyone |
| API edge | 1 load balancer (HTTPS 443 only, no port-80 listener), 1 listener, 1 rule, 1 target group, 1 certificate and its validation, 1 firewall (WAF) and its association, 1 cluster, 1 log group | the certificate validation blocks the apply until the CNAME exists |
| Services | **none**: no task definitions, no services | they need `api_image` |

## What plan B adds (12)

The web bucket (public-access block, ownership controls, versioning, encryption, policy), the web certificate and its validation, the CloudFront distribution, its function, response-headers policy and origin access control.
Check: aliases are `app.<web_domain>`, `<web_domain>` and `www.<web_domain>`; the distribution has **no** custom error response that turns a 403 or 404 into a 200; the bucket policy lets only this distribution read and denies plain HTTP.

## What plan C adds (9)

2 services (API and worker, `desired_count = 1` each), 4 task definitions (API, migration, provisioning, worker), the image-gated API alarms (running tasks, unhealthy targets, 5xx), the API's scalable target (held at the desired count; no scaling policy while `api_max_count` is null), **plus the four repository-only policy updates above**. The worker's four alarms and other API/worker foundations are already gated by API hosting; inventory all actual alarms rather than using the earlier resource totals as a current bill of materials.
Check in every task definition: the image is `...@sha256:<64 hex>` (never a tag), `readonlyRootFilesystem = true`, user `10001`, `DATABASE_SSL = require`, no secret in `environment` (secrets come from `secrets` with ARNs), and the migration task has **no task role**.
Tasks and services get a **public address** here (`assign_public_ip = true`) because the synthetic network has no NAT; that is expected in the synthetic profile only.
**Setting `api_image` starts the services at once**, before the logins and the schema exist, so they will fail until the one-off steps are done: that is expected and described in [staging-rehearsal.md](staging-rehearsal.md).

## After stage A: the SES sender's domain identity

Stage A was applied with SES verifying an **address** (`no-reply@staging.telesphoros.app`). An address identity signs mail as
`amazonses.com`, and the domain's DMARC record (`p=reject; sp=reject; adkim=s`) rejects that, so Cognito's invitations and reset
codes would never arrive. `cognito.tf` now makes the identity the address's **domain**, which SES DKIM-signs as. This is the only
change that may replace a resource after A. It takes **two targeted applies**, because Cognito refuses an SES identity that is
not verified yet, and the new domain verifies only once its DKIM CNAMEs are in DNS. `check-plan SES` checks every change in each
plan (a `-target` plan is always `complete: false`) and refuses the identity and the user pool in the same plan:

| Change | Plan | Expected action |
| --- | --- | --- |
| `aws_sesv2_email_identity.from` | 1 | replaced: `no-reply@staging.telesphoros.app` becomes `staging.telesphoros.app`. The address identity may already be verified; its mail is signed as `amazonses.com`, which DMARC rejects, so nothing that works is lost |
| `aws_iam_role_policy.password_notifier` | 1 | updated in place: the identity ARN and an `ses:FromAddress` condition for the no-reply address |
| `aws_cognito_user_pool.main` | 2 | **updated in place**; only `email_configuration.source_arn` changes. A replaced pool deletes every account: stop |

Run each command with the same AWS identity, Terraform binary and data directory as the stage A apply (`aws sts
get-caller-identity` must show the staging account first). From the identity's replacement until plan 2 is applied, Cognito
cannot send email; invite nobody in between.

```sh
umask 077
# Plan 1: the identity and the notifier policy
terraform -chdir=infrastructure/terraform plan -var-file=<yours> -var enable_web_hosting=false \
  -target=aws_sesv2_email_identity.from -target=aws_iam_role_policy.password_notifier -out=ses.tfplan
terraform -chdir=infrastructure/terraform show -json ses.tfplan > infrastructure/terraform/.terraform/ses.plan.json
node scripts/staging/check-plan.mjs SES infrastructure/terraform/.terraform/ses.plan.json
```

1. Apply exactly `ses.tfplan` (founder-run, as for A).
2. `terraform -chdir=infrastructure/terraform output -json ses_dkim_records`: add the three CNAMEs in Cloudflare, **DNS-only**, and keep them.
3. Wait until `aws sesv2 get-email-identity --email-identity staging.telesphoros.app --query '[VerifiedForSendingStatus, DkimAttributes.Status]'` prints `true` and `"SUCCESS"` (minutes to an hour; up to 72 hours). Amazon may publish only one of the three keys at first; SES checks the CNAMEs.
4. Plan 2, the user pool alone: `plan … -target=aws_cognito_user_pool.main -out=pool.tfplan`, then `show -json` and `check-plan.mjs SES` as above. Expect `0 to add, 1 to change, 0 to destroy`, then apply exactly `pool.tfplan`. Any earlier saved plan is stale after an apply; plan again rather than reusing it.
5. The `no-reply@staging.telesphoros.app` destination address in Cloudflare Email Routing (added for the old verification email) is no longer needed.
6. SES is still in its sandbox: invite only addresses verified in SES until production access is granted. Invite yourself once and check the message headers show `dkim=pass` and `dmarc=pass`.

Applied in staging on 2026-10-30 in this order, after a first single plan with all three changes failed at the user pool.

## Stop and ask when

- anything is destroyed or replaced (except the one SES identity replacement above, checked with `check-plan SES`); any update appears in A/B;
- `check-plan SES` refuses a plan, or the user pool appears in the same plan as the SES identity; C updates anything beyond the four specified repository-only policy changes, or any one of those changes is missing;
- a relaxation (`force_destroy`, no deletion protection, a 7-day key window, `recovery_window_in_days = 0`, a public task address) appears for a resource that is not in the tables above, or `deployment_profile` is not `synthetic`;
- a resource named in the quick checks appears; an unapproved Region, a backups bucket or a CloudTrail trail that is multi-Region appears. The web certificate in `us-east-1` and global CloudFront are expected by `web.tf`, even when the primary data Region differs; they are not off-site backups;
- a value that should be known is `(known after apply)` and the table says it is a literal (bucket names contain the account id, which the offline plan replaces with a random string, so read the real plan's names for the account you decided in D1);
- a quota, a free-plan restriction or a missing service is reported: record it in the plan's risks and do not work around it silently.

## Billable items to price before D2

RDS instance and storage; the load balancer; the firewall (web ACL and rules, plus per-request charges); CloudFront; Fargate tasks (two services, plus the one-off tasks) and **public IPv4 addresses** on them and on the load balancer
(check the account's current rate: it applies per address per hour); application and retained-state KMS keys; secrets; CloudTrail, CloudWatch logs and every actual audit/API/worker alarm; ECR storage; S3 storage/requests and retained state versions. Include any approved probe/restore resources, cleanup time and residual charges. The S3 gateway endpoint has no hourly charge. Nothing here has been priced. Require the founder's ceiling, staffed runtime and alert recipient; [budget notifications lag](https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-managing-costs.html) and are not a hard cap.

## After the review

Record who reviewed which plan file (`sha256sum a.tfplan`), the commit, and the answer to D2. Apply only the plan that was reviewed (`terraform apply a.tfplan`), one stage at a time, in a founder-run session, and stop and look after each.

Bring-up action checks A/B/C do not approve destruction. Teardown needs a separate
reviewed destroy plan and loss/rebuild scope, including the versioned web bucket's
explicit emptying step and preservation of the independent backend; see
[cleanup boundary](foundations-readiness.md#cleanup-boundary).
