# Plan FD-7a: the remote Terraform state backend

Status: **standalone bootstrap built and verified locally after founder approval on 2026-10-16.** See [the runbook](../../ops/terraform-state.md). Main-backend wiring, Actions coverage and live acceptance remain open; nothing was applied. It needs no AWS access to write; building it needs none either (everything is proved offline), and applying it is the founder's step in Phase 0 of [FD-7](fd7-staged-synthetic-deploy.md).

## Why

Three documents say the same thing: the Terraform root must not be applied until an encrypted, locked, access-restricted S3 backend exists ([Terraform README](../../../infrastructure/terraform/README.md) condition 2; [deployment.md](../../ops/deployment.md); [staging-plan-review.md](../../ops/staging-plan-review.md) step 3). `versions.tf` still deliberately configures no main backend. The separate bootstrap now exists as local code; no bucket was created by this build. Phase 0 of FD-7 names it as its own, separately approved change (decision D7, approved by the founder on 2026-10-16).

## Facts (checked in the repository) and assumptions

Facts:

- `versions.tf` has `required_version = ">= 1.6"` and no backend block; CI pins Terraform `1.16.5` and runs `terraform init -backend=false` (`.github/workflows/ci.yml`, job `terraform`), so a backend block does not change what CI initializes.
- Nothing has ever been applied, so there is no existing state to migrate.
- The state holds resource identifiers (and, for some resources, attribute values), so it is protected like the rest of the data plane even though the data is synthetic.
- FD-7 Phase 2 ends with a `terraform destroy` of the staged environment. State kept in the same root would be destroyed with it.

Assumptions (to confirm before building):

- S3 native locking (`use_lockfile = true`, Terraform 1.11 and later) is acceptable instead of a DynamoDB lock table. It removes one resource and one set of permissions.
- The founder-run apply identity (decision D4) is the only principal that reads or writes state.
- The Region is the one the founder supplies in D1; it is a variable, never a constant.

## Design and delivery boundaries

1. **A second, separate root** at `infrastructure/terraform-state/`. It creates only the state bucket, its key and its policy. Because it is separate, destroying the staged environment cannot delete the state, and the main root stays unchanged.
2. **The bucket:** versioning on; encryption with its own KMS key (rotation on); all public access blocked; ownership controls; a policy that denies non-TLS and unencrypted writes and allows only the named apply principal; old noncurrent versions expire after a stated number of days; `prevent_destroy` on the bucket and key; no `force_destroy`.
3. **Locking:** the bootstrap output describes `use_lockfile = true` for the future backend configuration. It does not activate that configuration. No DynamoDB table.
4. **The bootstrap problem:** this root cannot keep its state in itself. It applies once with local state, which lives on the founder's machine, is gitignored, and records only the bucket and key identifiers. Losing it is recoverable (the bucket can be imported) and is written into the runbook.
5. **Wiring the main root (not implemented by the standalone bootstrap slice):** an empty `backend "s3" {}` block in `versions.tf`, with the bucket, key, Region and encryption settings supplied at `terraform init -backend-config=<file>`. The file is gitignored like `*.tfvars`; an example with placeholders is committed. `required_version` rises to `>= 1.11` (CI already runs 1.16.5).
6. **A runbook** `docs/ops/terraform-state.md`: create the state root, initialize the main root against it, what to do if a lock is stuck, and how the state is backed up.

## How it will be proved (offline)

- `terraform fmt`, `validate` and `terraform test` with `mock_provider` for the new root, added to the CI `terraform` job so the new root cannot rot.
- A text guard (the pattern of `registry.guard.test.mjs`) with injected defects: versioning off, public access not blocked, no TLS-only deny, no KMS, no `prevent_destroy`, a hard-coded account or Region, a `COMPLIANCE`-style lock that would block cleanup.
- The existing main-root guards and offline plans still pass unchanged after the `versions.tf` edit.

Not provable offline: that S3 native locking really refuses a second concurrent apply, and that the bucket policy admits the real apply identity. Both are checked on the first real `init` and recorded, not assumed.

## Decisions

- **D7: approved** (founder, 2026-10-16: create the state bucket as a separate, approved change first).
- **Resolved for the approved local build:** a separate Terraform root with native mock tests and weakening guards. Mandatory Actions coverage remains assigned to the other session. Naming, retention and the trusted identity remain explicit required inputs before activation. The local build approval authorizes no live creation.
- **Still needed only for the apply, not for the build:** D1 (account and Region).

## Risks and open points

- Raising `required_version` touches the main root's `versions.tf`. It is the only change to an existing file besides CI and the README's status line.
- Local bootstrap state is a single point of loss on the founder's machine; mitigated by import steps in the runbook.
- A backend that is correct offline can still be refused by the account (permissions, a service limit); the first real init finds it.
- The state bucket outlives the rehearsal on purpose, so it needs its own teardown decision under D8.

## What it does not touch

The main root's resources and profiles, application code, the BAA position, any AWS credential or account, DNS, or any real data. This plan, and its PR, apply nothing.

## Historical verification of the plan

Documentation only. Each fact above comes from `infrastructure/terraform/versions.tf`, `.github/workflows/ci.yml`, the Terraform README, `docs/ops/deployment.md` and `docs/ops/staging-plan-review.md`. Nothing is verified in AWS, and Terraform was not available in the authoring environment, so the S3 native-locking requirement (1.11 and later) is stated from the Terraform documentation, not from a local run.

## Standalone implementation clarification (2026-10-16)

The approved local slice creates only `infrastructure/terraform-state/` and documentation. Region, bucket name, exact default-workspace state key, trusted existing IAM owner and noncurrent-version age have no defaults. The root returns an encrypted/locked backend descriptor but does not configure a backend anywhere. Main root, Actions and root package scripts stay unchanged. The trusted owner administers its policies; no separate application/CI identity is granted access.

Native plans mock computed identifiers while inspecting actual policy JSON; source guards cover deletion protection. Tests and limitations are in the runbook. The original proposal above includes later backend wiring and CI steps; neither is implied complete by this local build. Naming/retention/identity/account/Region and budget still require explicit choices before any live operation.


## Local mandatory CI assembly — 2026-10-17

The approved standalone delivery `aec888e` is assembled with required CI coverage
on the separate local `feat/fd7a-required-ci` branch. The existing `terraform`
check now requires both roots' fmt/init/validate/all mocked plans and the new
root's source guard/fresh policy suite, preserving its name, 15-minute cap,
Node 22.22.0, Terraform 1.16.5 and reviewed provider locks. All service profiles,
cleanup/evidence/joining rules and the shared 30-minute budget remain unchanged.
Local verification passed 171 policy cases, 21 source guards, 22 standalone
plans, 96 infrastructure tests, 33 main-root plans and 131 CI controls without
selected skips. See [verification](../../verification/fd7a-required-ci.md).
Prior stage records remain historical. Hosted CI, separate backend wiring and
live AWS custody/permission/locking/recovery acceptance remain open. This local
slice authorizes no publication, cloud operation or deployment.


## Local reconciliation with current main — 2026-10-17

A separate fresh-main candidate now reconciles the verified `2fbc1b3` payload
with current main `efb6103`, preserving all earlier candidates, references and
documentation history. The implementation and CI selection are unchanged, with
fresh local acceptance repeated. The previous base/drift records above remain
historical. See [reconciliation verification](../../verification/fd7a-required-ci.md#local-reconciliation-with-current-main--2026-10-17).
Hosted CI, publication, backend activation and live acceptance remain separate.


## Historical main snapshot — before FD-7a reconciliation

The following is the exact committed record at main `efb6103ab7732f489b17d0e35c5fbff6bf073ef1`,
retained verbatim as historical source material. Its pending/current statements
belong to that snapshot; the dated FD-7a sections above describe later local work.

````markdown
# Plan FD-7a: the remote Terraform state backend

Status: **draft, plan only.** Nothing here is built, approved for build, applied or run. It needs no AWS access to write; building it needs none either (everything is proved offline), and applying it is the founder's step in Phase 0 of [FD-7](fd7-staged-synthetic-deploy.md).

## Why

Three documents say the same thing: the Terraform root must not be applied until an encrypted, locked, access-restricted S3 backend exists ([Terraform README](../../../infrastructure/terraform/README.md) condition 2; [deployment.md](../../ops/deployment.md); [staging-plan-review.md](../../ops/staging-plan-review.md) step 3). `versions.tf` deliberately configures no backend, and none exists. Phase 0 of FD-7 names it as its own, separately approved change (decision D7, approved by the founder on 2026-10-16).

## Facts (checked in the repository) and assumptions

Facts:

- `versions.tf` has `required_version = ">= 1.6"` and no backend block; CI pins Terraform `1.16.5` and runs `terraform init -backend=false` (`.github/workflows/ci.yml`, job `terraform`), so a backend block does not change what CI initializes.
- Nothing has ever been applied, so there is no existing state to migrate.
- The state holds resource identifiers (and, for some resources, attribute values), so it is protected like the rest of the data plane even though the data is synthetic.
- FD-7 Phase 2 ends with a `terraform destroy` of the staged environment. State kept in the same root would be destroyed with it.

Assumptions (to confirm before building):

- S3 native locking (`use_lockfile = true`, Terraform 1.11 and later) is acceptable instead of a DynamoDB lock table. It removes one resource and one set of permissions.
- The founder-run apply identity (decision D4) is the only principal that reads or writes state.
- The Region is the one the founder supplies in D1; it is a variable, never a constant.

## Proposed design (for a later build slice)

1. **A second, separate root** at `infrastructure/terraform-state/`. It creates only the state bucket, its key and its policy. Because it is separate, destroying the staged environment cannot delete the state, and the main root stays unchanged.
2. **The bucket:** versioning on; encryption with its own KMS key (rotation on); all public access blocked; ownership controls; a policy that denies non-TLS and unencrypted writes and allows only the named apply principal; old noncurrent versions expire after a stated number of days; `prevent_destroy` on the bucket and key; no `force_destroy`.
3. **Locking:** `use_lockfile = true` in the backend configuration. No DynamoDB table.
4. **The bootstrap problem:** this root cannot keep its state in itself. It applies once with local state, which lives on the founder's machine, is gitignored, and records only the bucket and key identifiers. Losing it is recoverable (the bucket can be imported) and is written into the runbook.
5. **Wiring the main root:** an empty `backend "s3" {}` block in `versions.tf`, with the bucket, key, Region and encryption settings supplied at `terraform init -backend-config=<file>`. The file is gitignored like `*.tfvars`; an example with placeholders is committed. `required_version` rises to `>= 1.11` (CI already runs 1.16.5).
6. **A runbook** `docs/ops/terraform-state.md`: create the state root, initialize the main root against it, what to do if a lock is stuck, and how the state is backed up.

## How it will be proved (offline)

- `terraform fmt`, `validate` and `terraform test` with `mock_provider` for the new root, added to the CI `terraform` job so the new root cannot rot.
- A text guard (the pattern of `registry.guard.test.mjs`) with injected defects: versioning off, public access not blocked, no TLS-only deny, no KMS, no `prevent_destroy`, a hard-coded account or Region, a `COMPLIANCE`-style lock that would block cleanup.
- The existing main-root guards and offline plans still pass unchanged after the `versions.tf` edit.

Not provable offline: that S3 native locking really refuses a second concurrent apply, and that the bucket policy admits the real apply identity. Both are checked on the first real `init` and recorded, not assumed.

## Decisions

- **D7: approved** (founder, 2026-10-16: create the state bucket as a separate, approved change first).
- **Open, for the build slice's own go:** separate Terraform root (recommended) or an AWS CLI runbook; whether CI should run the new root (recommended: yes); the noncurrent-version retention period; the name prefix.
- **Still needed only for the apply, not for the build:** D1 (account and Region).

## Risks and open points

- Raising `required_version` touches the main root's `versions.tf`. It is the only change to an existing file besides CI and the README's status line.
- Local bootstrap state is a single point of loss on the founder's machine; mitigated by import steps in the runbook.
- A backend that is correct offline can still be refused by the account (permissions, a service limit); the first real init finds it.
- The state bucket outlives the rehearsal on purpose, so it needs its own teardown decision under D8.

## What it does not touch

The main root's resources and profiles, application code, the BAA position, any AWS credential or account, DNS, or any real data. This plan, and its PR, apply nothing.

## Verification of this plan

Documentation only. Each fact above comes from `infrastructure/terraform/versions.tf`, `.github/workflows/ci.yml`, the Terraform README, `docs/ops/deployment.md` and `docs/ops/staging-plan-review.md`. Nothing is verified in AWS, and Terraform was not available in the authoring environment, so the S3 native-locking requirement (1.11 and later) is stated from the Terraform documentation, not from a local run.

````
