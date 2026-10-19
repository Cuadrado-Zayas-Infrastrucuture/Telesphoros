# FD-7a: standalone state bootstrap

This root prepares a private state bucket and its KMS key independently of the
synthetic application root. It is built and verified locally; nothing was applied.
The main root has partial S3 source wiring; live backend activation remains unverified.
Start with [foundations readiness](../../docs/ops/foundations-readiness.md) for
pending founder decisions and separate inventory/bootstrap/activation approvals.
This standalone root has no modules, live data lookups,
credentials, application resources or deployment commands here.

Required inputs have no defaults:

| Input | Meaning |
| --- | --- |
| `region` | Owner-selected commercial AWS Region |
| `bucket_name` | Globally unique, lowercase DNS label without dots |
| `state_key` | One default-workspace path ending `.tfstate` |
| `state_principal_arn` | Existing trusted bootstrap/apply role or user; no wildcard, root or STS session |
| `noncurrent_retention_days` | Explicit approved positive integer; historical state expires after this age |

The bucket is versioned, ACL-free, public-blocked and KMS-encrypted. Requests from
other principals or over insecure transport are denied. Only the chosen state and
`.tflock` objects can be read/written; the temporary lock can be deleted, while
state deletion and direct historical-version deletion are denied. Bucket metadata
listing is permitted within this dedicated bucket. The owner can administer the
policies and therefore remains trusted; this is not a restricted application or CI
identity. Key administration does not directly grant cryptographic wildcard rights.

Old versions expire through the explicit lifecycle rule; the API deletion denies
do not block S3 Lifecycle. Current state never expires. There is no Object Lock:
retention locks must not prevent native Terraform lockfile removal.

## Local verification

Use the repository's pinned Node 22.22.0/pnpm 10.28.0 and Terraform 1.16.5. The AWS
provider lock reuses the reviewed 6.68.0 release; do not upgrade it during bootstrap.

```sh
terraform fmt -check -recursive infrastructure/terraform-state
terraform -chdir=infrastructure/terraform-state init -backend=false -lockfile=readonly
terraform -chdir=infrastructure/terraform-state validate
terraform -chdir=infrastructure/terraform-state test
node --test infrastructure/terraform-state/guard.test.mjs
node --test infrastructure/terraform-state/policy.test.mjs
pnpm test:infra
```

All native tests are mocked plans. They inspect real generated policy JSON;
computed key identifiers alone are mocked. No real account is needed. The separate
guard suite checks source-only lifecycle safeguards and weakens copies in memory.
The policy suite runs one fresh mocked plan from `tests/policy.tftest.hcl`, then
checks all 145 original permission cases, 16 promoted review cases and 10 deliberate
in-memory policy defects (171 tests total). The promoted cases cover reads and lock
release without write headers, history/deletion safeguards, missing KMS context,
direct key use, bucket metadata and anonymous refusal. The suite
requires the initialized provider and `terraform` on PATH (or an explicit
`FD7A_TERRAFORM_BIN`). No saved policy fixture or Python dependency is used.
It retains full producer stdout/stderr and exit metadata in a unique private
temporary directory; set `FD7A_TEST_EVIDENCE_DIR` to an existing evidence parent
to retain them at a chosen location. Producer failures, missing plans and skipped
fixtures fail the suite. These local policy-model checks do not emulate AWS IAM,
SCPs, permission boundaries or service acceptance, and do not prove live recovery.
See the [operating boundary and retained verification](../../docs/ops/terraform-state.md).

## Current Actions coverage (local assembly, 2026-10-17)

The required [`terraform` job](../../.github/workflows/ci.yml#L879-L915) now runs
fmt, backend-disabled/read-only-lock initialization, validation and all mocked
plans for both roots, followed by the standalone source guard and fresh policy
suite. The existing [`verify` tripwires](../../.github/workflows/ci.yml#L59-L62)
still run `pnpm test:infra` and `pnpm test:ci-config`.

This describes local workflow wiring; exact-head hosted CI acceptance remains
pending. See the [dated local reconciliation record](../../docs/verification/fd7a-required-ci.md#local-reconciliation-with-current-main--2026-10-17)
for completed checks and remaining gates.

## Historical Actions handoff (preserved 2026-10-17)

The paragraph below records the pre-assembly handoff. The local wiring described
above supersedes it; the original wording is retained verbatim as history.

These commands are not yet wired into Actions. The other session owns that work;
new-root mandatory coverage and exact-head CI remain publication gates.
