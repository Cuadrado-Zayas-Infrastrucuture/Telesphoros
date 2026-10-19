# Terraform state bootstrap: built locally, not applied

FD-7a has an independent root at `infrastructure/terraform-state/`. Its scope
is the state bucket, its key, policies, version lifecycle and a backend
descriptor. Main now declares a partial S3 backend in
`infrastructure/terraform/versions.tf`; this is source wiring only, with no backend
activation, identity provisioning or AWS operation performed by this change.
The bootstrap root keeps separate local state;
the synthetic environment cannot destroy it as part of its own teardown.

Start with [foundations readiness](foundations-readiness.md) for the pending
founder decisions and separate inventory/bootstrap/activation approvals. No live
account or state target was inspected by the offline runbook update.

## Trust boundary

State, historical versions and local bootstrap records are confidential. No keys,
credentials, state dumps or saved plans belong in chat, committed files or public
logs. Required account/Region/principal/naming/retention decisions are inputs, not
live defaults. The tests use fictitious values only.

The named existing IAM role/user owns bootstrap and application-infrastructure
state access. The provider constrains the account to that ARN's account. The same
trusted owner can change bucket/key policies; this design does not protect against
an owner deliberately removing its protections or losing that identity. Selecting
this identity and proving its recovery/custody is a live acceptance requirement.
Do not give the application, worker or an unreviewed CI role these rights.

Bucket policies deny non-TLS access, other principals, objects outside the exact
state/lock paths, current-state deletion and direct version deletion. State has
read/write/version-read permissions; only `.tflock` permits ordinary deletion.
Independent encryption/key denies require the correct SSE-KMS headers on writes.
The returned `backend_config` requires encryption and `use_lockfile = true`, but
is a descriptor, not an activated backend. [Terraform S3 backend](https://developer.hashicorp.com/terraform/language/backend/s3).

The key permits normal cryptographic use only through S3 in the chosen Region,
account and two object encryption contexts. Bucket Keys stay disabled because
they would replace the object context with a bucket context.
[SSE-KMS and encryption context](https://docs.aws.amazon.com/AmazonS3/latest/userguide/UsingKMSEncryption.html#encryption-context).
The exact-role condition also applies to sessions assumed into that role.
[aws:PrincipalArn](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_condition-keys.html#condition-keys-principalarn).

## Retention and deletion

Versioning and `prevent_destroy` protect against accidental infrastructure changes;
`force_destroy` is false, the key rotates and its deletion window is 30 days.
These are Terraform controls, not irreversible cloud locks. A trusted administrator
can change policy/configuration and cloud permissions still need real verification.

The required noncurrent retention input controls expiration of old versions under
the state-key prefix, including historical lock versions. No current-version
expiration is configured. API deletion denies do **not** prevent S3 Lifecycle from
expiring eligible old versions; select the age knowingly and retain an independent
approved state backup. [S3 expiration semantics](https://docs.aws.amazon.com/AmazonS3/latest/userguide/lifecycle-expire-general-considerations.html).
Native state locking is concurrency coordination, not S3 Object Lock.

## Main backend configuration (source only)

Main requires Terraform >= 1.11, matching the standalone root; CI remains pinned to
1.16.5. Native S3 locking was introduced in 1.10; 1.11 is the project's conservative
floor, not the feature's introduction version.
[HashiCorp changelog](https://github.com/hashicorp/terraform/blob/v1.10.0/CHANGELOG.md).

`versions.tf` commits `encrypt = true` and `use_lockfile = true`. The example
`infrastructure/terraform/backend.s3.tfbackend.example` supplies four placeholder
strings only. During a separately approved activation, prepare the private copy
`backend.s3.tfbackend` from the actual standalone `backend_config` output:

| Descriptor field | Effective main-backend configuration |
| --- | --- |
| `bucket` | private file: exact bootstrap bucket |
| `key` | private file: exact approved state key |
| `region` | private file: exact bootstrap Region |
| `kms_key_id` | private file: exact bootstrap KMS key ARN |
| `encrypt` | `true` in `versions.tf` |
| `use_lockfile` | `true` in `versions.tf` |

Use top-level HCL attributes in the private file, with no enclosing block. Transcribe
and privately compare the four strings against the descriptor; do not rename its JSON
output as HCL. Do not include credentials, profiles, role assumptions, endpoints,
workspace prefixes, DynamoDB settings or bypass flags. Both the live file and backup
copies are gitignored; the placeholder example and provider locks remain trackable.
Keep private files, cached backend metadata, state and saved plans on approved
encrypted storage with restrictive permissions (`umask 077` before creating them).
Gitignore is not custody or encryption evidence.

Terraform merges backend files/CLI arguments over source settings. Before activation,
reject unexpected `TF_CLI_ARGS*` overrides and extra `-backend-config` flags; review the
four-field file and require the effective six values above to match the descriptor.
Never print private config, cached metadata, state or credentials to logs/chat.
The source guard protects the committed contract; it cannot validate a future private
file or prevent CLI overrides. The bucket policy does not enforce lock acquisition:
the client must retain native locking. [Configuration precedence](https://developer.hashicorp.com/terraform/language/backend).

Only the `default` workspace is supported. Before any real init, check both the selected
workspace/cache and any `TF_WORKSPACE` setting; stop if not default. A nondefault
workspace uses a different state path outside this policy's contract. Synthetic and
production must never share a state location. Another environment needs its own
separately approved state/trust contract; do not broaden paths to make it work.
[S3 workspace paths and locking](https://developer.hashicorp.com/terraform/language/backend/s3).

### Initialization and migration gate

Inventory local authoritative state, cached backend metadata and any existing remote
state privately before init. This source change has not inspected AWS or proved that
any target is empty. Unknown ownership, lineage, a conflicting target, wrong identity,
wrong account/Region or a profile/key mismatch is a stop. Preserve a protected backup;
do not discard an old state file because an earlier document described an empty stack.

After the separate activation authorization and the gates below, an approved new-target
session uses this command from the repository root (never the example file):

```sh
terraform -chdir=infrastructure/terraform init -input=false -backend-config=backend.s3.tfbackend
```

Real-backend init is an activation operation that can acquire locks/write state; it is
not an offline connectivity probe. Existing state or cached backend changes require a
separate migration decision first. Do not automatically add `-reconfigure` (which
disregards the old backend without migrating), `-migrate-state`, `-force-copy` or
force-unlock. [Initialization options](https://developer.hashicorp.com/terraform/cli/commands/init).

If initialization, locking or permission checks fail, preserve private native errors
and exit status, stop writers and investigate. Do not switch to local state, disable
locking, weaken encryption or expand policies to bypass the refusal. Before activation,
the source PR can be reverted normally. After activation, reverting code does not move
or recover state: preserve version/lineage records and follow a separately approved
recovery/migration procedure. No state deletion, bucket/key recreation or automatic
teardown is a rollback for this wiring.

CI still uses backend-disabled/read-only-provider-lock initialization and mocked tests
for both roots. No workflow or deployment identity is added. Offline checks do not
establish live permissions, locking, custody or recovery.

## Before any later activation

1. Obtain separate live authorization and record the account, Region, named owner,
   global bucket name, exact state key, historical retention and spending ceiling.
   Verify the caller is the configured existing owner and can retain policy access;
   key policy lockout checks remain enabled.
2. Set a restrictive local umask (`077`) before producing local state or plans.
   Use approved encrypted local storage, verify file permissions, and keep a
   protected bootstrap-state backup outside the synthetic checkout/environment.
   Gitignore is not encryption or custody evidence.
3. Review the bootstrap-only plan and its costs. No application resources should
   appear. An apply, backend migration or state change needs its own authorization.
4. After separately approved creation, retain bucket/key identifiers and protected
   state custody records. Never infer permission success from a mocked plan.
5. Review the source wiring and private configuration through the initialization gate
   above. Confirm the effective six-field descriptor, default workspace, owner and
   account/Region; this policy intentionally does not authorize arbitrary state paths.
6. In the approved environment prove write/read, historical recovery, refusal to
   delete state, rejection of a second concurrent lock holder, lock release, wrong
   identity/path/key/header refusals and preservation through synthetic teardown.
   Use disposable canaries; do not fault required state or retained evidence.

The [isolated probe procedure](foundations-readiness.md#state-probe-preparation-still-required)
must be prepared and reviewed before live testing, including its resources, costs
and retirement. Do not issue destructive refusal tests or bad writes against
authoritative state, add extra allowed object paths, or reuse real state lineage
for a fixture. A successful mocked policy suite does not supply that procedure or
prove AWS enforcement. Keep the bootstrap bucket/key/history and protected local
records outside application teardown.

## Recovery boundary

If the local bootstrap state is lost, stop writes and recover its protected backup
first. If no usable backup remains, review/import the existing bucket, KMS key and
each separately managed configuration into a new protected local state; refresh
and require a reviewed no-change plan before proceeding. Do not recreate the key,
delete the bucket or destroy the synthetic root to recover bookkeeping.

For main state, retain exact version metadata, stop all writers and preserve a
protected copy before any separately authorized restore. Restore a verified older
state as a new current object, with the required encryption and key; do not delete
history. A force-unlock, retention change, key replacement or teardown is never an
automatic repair. Confirm the prior lock owner is stopped and obtain a written
blast-radius review before any such operation. This slice performs none of them.

## Local verification and Actions handoff

The [root README](../../infrastructure/terraform-state/README.md) lists commands.
Local verification passed 21 mocked native plans, 21 source/weakening guards and
the existing 96-test infrastructure suite. All 33 unchanged main-root plans passed,
including all 13 F07 native-origin probes. Nine deliberate native defects were
rejected by intended assertions; original bytes were restored and the 21 plans
passed again. Detailed producer exits/logs and preservation proof are retained in
the task's external FD-7a verification receipt. No AWS enforcement or main-backend
activation is established by these checks.

The subsequent local test promotion makes all 145 review policy cases and 10
mutation checks permanent in `policy.test.mjs`, with the model in
`policy-probes.mjs`. Every original request and expected outcome is retained.
The suite generates policies from one fresh, plan-only mocked fixture under
`tests/`; it does not load a captured plan or require Python. Mutations affect
cloned policies in memory and must produce the specific expected permission
change. The source guard now covers both native test files.

Focused verification passed all 155 policy/mutation tests, 21 source guards and
22 native mocked plans (the original 21 plus the policy producer fixture), along
with fmt/validate, the unchanged 96-test infrastructure suite and 33 main-root
plans. Four producer-failure controls confirmed that a nonzero exit, empty output,
skipped fixture or malformed JSON fails the new suite. Complete producer output
and native exit metadata are retained before parsing. These are policy-subset
checks, not an AWS IAM simulator or a live recovery rehearsal.

The first promotion run selected state history for the version-deletion mutation;
the overlapping state-deletion deny correctly kept it denied. The permanent
challenge now uses lock history to isolate the version-deletion safeguard. The
failed run is retained alongside the corrected passing verification. No resource
policy, main backend, Actions or application code changed during this promotion.

An early guard experiment showed that a generic `status = "Enabled"` check could
be satisfied by the lifecycle rule while bucket versioning was suspended. The
guard now checks the versioning resource specifically. An initial existing-suite
run lacked the isolated checkout's dependencies; a frozen offline install with
scripts disabled restored them and the full 96 tests passed. Neither is hidden as
a successful initial run.

The Actions owner must integrate the new root's fmt/validate/mock-plan/source-guard/policy-suite
commands into mandatory coverage before publication readiness. No workflow, main
backend, Dockerfile or root package script is changed here. Real IAM/KMS/locking,
policy acceptance, custody, cost and recovery remain separate live gates.

## Fresh current-main integration (2026-10-16)

`feat/fd7a-current-main` reuses the complete standalone implementation and all
permanent policy/mutation cases from `40700c7`, directly on main `7987a68c7825d05065215f26fa3f1724011d4bf6`.
The status conflict is resolved by keeping all main status sections and the
standalone FD-7a entry. Both original source and all F06/F07/combined references
remain frozen. No existing infrastructure, backend configuration, Actions, root
package script, application behavior or provider version changes.

Fresh verification passed 145 policy probes plus 10 targeted mutations (155/155),
21 source guards, 22 standalone mocked plans, 96 existing infrastructure tests and
33 main-root mocked plans; both roots passed fmt and validate. No selected tests
skipped. Runtime pins were Node 22.22.0, pnpm 10.28.0 and Terraform 1.16.5 with
locked AWS provider 6.68.0. Backends and cloud credentials stayed disabled; all
plans were mocked. The initial sandbox provider-start failure and initial existing
suite failure from missing local dependencies are retained separately; provider
process permissions and a frozen offline install with scripts disabled resolved
them without source changes. Full outputs and native exits are retained in the
task's `work/fd7a-current-main-verification/` evidence directory.

The earlier producer-fault experiments and additional native weakening tests
remain historical evidence; this refresh did not rerun them. No application,
browser, image or full backend profile run is claimed for this infrastructure-only
port. Mandatory new-root Actions coverage remains with the other session;
publication, backend activation, live permission/locking/recovery acceptance and
spending still need their own gates and authorization.


## Delivery refresh from current main (2026-10-17)

A new `feat/fd7a-delivery` checkout starts directly from main `c12c47a7e3865ffec7cdbaa7844aafa4b003041b`. Original `40700c7` and prior integration `3243fef` remain frozen. All ten standalone-root files, including provider lock, policy model and permanent probes, are reused byte for byte. Current-main status content and both earlier session records are preserved as dated history.

Fresh credential-disabled verification passed 145 policy probes plus ten mutation checks (155/155), 21 source/weakening guards, 22 standalone mocked plans, 96 existing infrastructure tests and 33 main-root mocked plans; both roots passed fmt, `init -backend=false -input=false -lockfile=readonly` against the verified cached providers, and validate. Node22.22.0, pnpm10.28.0, Terraform1.16.5 and AWS6.68.0 remain pinned. No selected tests skipped and no tracked bytes changed during verification. Full native outputs, producer exits and generated policy evidence are retained externally under `work/fd7a-delivery-verification/`. Earlier extra producer-failure/native-weakening experiments remain historical and were not rerun.

No Actions, application, root package/lock or existing Terraform/main-backend changes were made. Mandatory standalone-root coverage remains an Actions-owner publication prerequisite; its patch and fresh assembled-candidate acceptance are separate work. No application/browser/image/full-backend-profile result or exact-head hosted CI is claimed by this infrastructure refresh. Actual IAM/KMS/locking, bootstrap custody/recovery, backend wiring and all cloud creation/activation remain separately authorized gates. Nothing was pushed, published, merged, applied or deployed.

## Permanent review probes (2026-10-17)

The 16 read-only review cases are now returned by `reviewPolicyCases` in the existing
policy model and run by `policy.test.mjs` against its one fresh native mocked plan.
All original names, requests and expected outcomes are retained. The original 145
permission cases, evaluator and ten mutations are unchanged: the suite now has
161 permission cases and ten mutations, **171 tests total**. No captured review
fixture is used by the permanent suite.

The added cases cover state/history/lock reads and ordinary lock release without
write-encryption headers, state/history deletion refusals, direct KMS crypto and
missing context refusals, absent direct key-deletion/grant permissions, metadata
access and anonymous refusal. These remain policy-subset checks, not AWS IAM/STS
simulation or a live lock/recovery drill.

Fresh verification passed 171 policy/mutation tests, 21 source guards, 22 standalone
mocked plans, 96 existing infrastructure tests and 33 main-root plans. Both roots
passed fmt, backend-disabled initialization with the read-only provider lock and
validate. No selected tests skipped; all tracked bytes stayed fixed during these
checks. Complete native output, producer exits and exact case-equivalence evidence
are retained externally in `work/fd7a-probe-promotion/`.

Both earlier FD-7a candidates and F06/F07/combined are preserved. Terraform resource
definitions, inputs, outputs, native fixtures and provider locks remain unchanged.
The Actions handoff is prepared here as an external task artifact and is not sent;
mandatory CI coverage still needs the owning session's separately authorized work.
No workflow, main-backend, application, root package or deployment change is included.


## Mandatory CI assembly (local, 2026-10-17)

The historical promotion records above describe earlier stages. The separate
`feat/fd7a-required-ci` candidate now extends the existing required `terraform`
job to both roots, preserving its name and 15-minute cap. From the repository
root it runs fmt, backend-disabled/read-only-lock init, validate and all mocked
plans for each root, followed by the standalone source guard and policy suite.
The policy suite creates its own fresh producer directory; complete native
stdout, stderr and exit metadata are retained with the pinned artifact action,
even after failure. No captured plan can satisfy this producer.

Local acceptance: 171 policy/mutation cases, 21 source guards, 22 standalone
plans, 96 existing infrastructure tests, 33 main-root plans and 131 CI controls
all passed with no selected skips. Negative controls exercise native exit 17,
skipped/missing/duplicate plans, malformed output and stale prior evidence.
[The verification record](../verification/fd7a-required-ci.md) gives exact scope,
accounting and remaining gates. Resource/policy configuration, native fixtures,
provider locks and original/promoted probes are unchanged. Service jobs retain
their existing profiles, cleanup, joining gates and one shared 30-minute budget.
Hosted Linux CI, backend activation and live AWS permission/locking/recovery
acceptance remain unrun; publication and cloud operations require separate
instructions.


## Reconciled local candidate — 2026-10-17

The local CI candidate was subsequently reconciled onto freshly fetched main
`efb6103` in a separate checkout/branch, preserving `2fbc1b3` and both earlier
FD-7a candidates. New main documentation and the historical records above are
retained. Fresh local verification repeats the full 171/21/22/96/33 acceptance
and 59 focused/131 full CI controls, with zero selected skips; the approved root,
fixtures, policies, locks and CI bytes are unchanged. See the dated
[reconciliation record](../verification/fd7a-required-ci.md#local-reconciliation-with-current-main--2026-10-17).
No backend activation, cloud operation, hosted rerun or publication occurred.


## Permanent producer-fault controls — 2026-10-17

A fresh local main-based candidate promotes the four `cf532cd` review-only
producer faults into the existing refusal harness: missing executable,
termination, empty output and timeout. All ten refusal controls now run in the
63 focused / 135 full CI controls. Policy cases remain 171/171, with 21 source
guards, 22 standalone plans, 33 main-root plans and 96 infrastructure tests passing
without selected skips. The timeout test shortens only its isolated child's
deadline; the real 120-second producer timeout, workflow, resources, locks and
fixtures are unchanged. Native receipts and full outputs are retained before
assertions. See the [promotion record](../verification/fd7a-required-ci.md#producer-fault-probes-made-permanent--2026-10-17).
Both earlier FD-7a candidates, the reviewed candidate and F06/F07/combined remain
preserved. Hosted Linux CI and every live backend/permission/recovery acceptance
gate remain separate; no publication, cloud operation or deployment occurred.


## Delivery reconciliation on current main — 2026-10-17

The local delivery candidate starts from main `95c6ead`, retaining worker fix
#154 unchanged. Its standalone root, policies, fixtures, locks and required
workflow are the reviewed FD-7a bytes; its existing refusal harness retains all
ten cases, including the four promoted producer faults. The README describes
current Actions wiring and labels the original handoff as history. Both sets of
earlier dated records remain verbatim. The [delivery verification record](../verification/fd7a-required-ci.md#delivery-reconciliation-on-current-main--2026-10-17)
separates this assembly from older captures and future hosted/live acceptance.
The real producer deadline stays 120 seconds; only the timeout control's nested
child uses 150 ms. No main-backend activation or cloud operation is included.


## Native producer error correction — 2026-10-17

The local correction from `b58ebc5` requires exit 0, no termination signal and no
native spawn error before parsing a policy plan. Status 0 alone is insufficient:
a timed-out producer can handle SIGTERM and exit 0 with native `ETIMEDOUT`.
The new finite refusal control checks this combination and the exact producer
failure reason; all four earlier fault controls remain. Complete native output
and exit receipts are still saved before acceptance assertions. The real producer
deadline remains 120 seconds; only the new nested regression uses 500 ms. No
resource configuration, backend wiring, workflow, credentials or worker behavior
changes. Fresh local verification and preserved-checkout proof are external in
`2026-10-17/new-chat/work/fd7a-native-error-fix`. Hosted CI and live AWS gates
remain open; no cloud operation, CI rerun, push or merge is part of this repair.
