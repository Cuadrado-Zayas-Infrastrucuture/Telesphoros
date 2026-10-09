# Plan FD-3: the synthetic Terraform profile

Status: **approved 2026-10-09 and built** (this document records the plan as approved, with the founder's three decisions and technical notes, and what the build changed). It needs no AWS access: everything is proved offline.

## Why

The account is on a free plan with no BAA and a closing date (about 9 April 2027). The production root assumes two Regions, Multi-AZ, a NAT route and irreversible protections. The rehearsal (FD-7) needs the same root to apply in **one Region, small, cheap and destroyable**, without weakening production.

Two things were found while reading:

1. **A latent bug.** With the default variables (`enable_api_hosting = false`) the root could not be *planned*: the two execution-policy documents in `api-compute.tf` had no `count` but indexed secrets that exist only with hosting on. `terraform validate` passes, so CI was green; the first real plan would have failed. Fixed here.
2. **A better proof.** `terraform test` with `mock_provider` runs a real plan offline on CI's pinned Terraform. It asserts what a profile creates and what it refuses, instead of only reading text. The text guards stay (they pin security settings).

## What was built

1. **`deployment_profile`** (`production` default, `synthetic`) and a check resource (`terraform_data.profile`, `profile.tf`) that refuses `synthetic` unless `environment = "staging"`, refuses a production environment on any profile but `production`, refuses a missing or one-zone network, and refuses `COMPLIANCE` locks under `synthetic`.
2. **Single Region under `synthetic`**: the backup-Region key and alias, the locked backups bucket and everything on it, the automated-backup replication and the backup job policy are counted by the profile; their outputs are null; the audit trail is single-Region.
3. **Small and destroyable under `synthetic`**: `db.t4g.micro`, single-AZ, no deletion protection, no final snapshot, one-day recovery window, no Performance Insights (support on the micro class is unverified, so it is off), Cognito deletion protection off, 7-day key windows, secrets deleted at once, `force_destroy` on the buckets, one-day GOVERNANCE audit lock.
4. **`network-synthetic.tf`**: a VPC, two public subnets pinned to two zones (RDS needs two even when single-AZ), an internet gateway, a route, the free S3 gateway endpoint, and a closed default security group. **No NAT gateway.** Tasks get a public address; the security groups are unchanged. A supplied `vpc_id` is used as given and the tasks stay private. `vpc_id` and `private_subnet_ids` are now optional variables, and required (checked) under `production`.
5. **The `count` bug fixed**, with a plan test that the default variables plan.
6. **Tests**: `profiles.tftest.hcl` (13 runs: default plan, production shape, production with hosting, synthetic shape, synthetic with hosting, synthetic with a supplied network, seven refusals); `profile.guard.test.mjs` (a ratchet over every place the root consults the profile, counted, with 23 broken-copy controls); the existing guards updated without loosening them; `terraform test` added to the `terraform` job of `ci.yml` and pinned by the CI-configuration guard; defect injection on the Terraform tests (26 injected defects, each failing at least one run, and an unmodified control that passes).
7. **Docs**: the Terraform README (profiles, how to rehearse and destroy, what `terraform test` does not prove), `example.tfvars.example`, `docs/ops/ci-cd.md`, STATUS.

## Founder decisions (2026-10-09)

1. The synthetic VPC is created inside this PR (one self-contained rehearsal, one destroy; the account's default VPC cannot be destroyed cleanly).
2. `terraform test` runs in CI.
3. Immediate secret deletion and `force_destroy` apply to `synthetic` only (both refused in production by the profile check).

Notes from the review of the plan, applied: the two subnets map to two distinct zones; the identity that runs the FD-7 destroy needs `s3:BypassGovernanceRetention`; counted resources change address (`aws_kms_key.backup[0]`), which is safe because nothing has been applied and is stated in the README and the PR.

## What it does not touch

Application code; production values and every existing production guard; Cognito MFA and password rules; the audit and key policies; web hosting (its bucket is not part of the profile); any AWS account (nothing is applied, no credentials are used).

## Risks and open points

- Mock providers prove the plan's shape, **not** that AWS accepts it (limits, quotas, a service the free plan refuses). The free plan's backup-retention limit is unverified; FD-7 step 0 finds it.
- Whether the provider removes locked object versions on `force_destroy` is **not verified**; FD-7 tests it with a real destroy.
- The `provider "aws" { alias = "backup" }` stays configured and unused under `synthetic`.
