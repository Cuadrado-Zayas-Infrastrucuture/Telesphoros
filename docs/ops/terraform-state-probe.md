# Isolated remote-state acceptance probe — procedure only

**No AWS command on this page has been run or approved.** This is the review
procedure requested by [foundations readiness](foundations-readiness.md). It does
not activate the application backend, create an identity, change the state-root
policy, authorize spending, or waive the first-apply gate. Fill the private
worksheet and approve the exact probe plan before any account access or apply.

## Boundary and decisions

Use a **separate scratch instance** of the unchanged
[`infrastructure/terraform-state/`](../../infrastructure/terraform-state/README.md)
root: a distinct globally unique bucket, KMS key, exact `.tfstate` key and local
bootstrap state. Use the same approved owner ARN, Region, policy source and
retention contract as the intended backend. Never put a canary path or scratch
Terraform lineage in the authoritative bucket. A separate local probe client
with only a built-in `terraform_data` marker writes the scratch state; it does
not plan or create application resources.

Record these values privately, outside Git/chat and on approved encrypted
storage. A placeholder or an unreviewed answer is a stop.

| Approval item | Required private record |
| --- | --- |
| Identity and scope | Account ID, Region, existing MFA-protected owner ARN, caller check, identity-recovery owner, an optional named denied principal and a valid alternate KMS key for negative tests. No new identity or key is implied; mark unavailable cases untested. |
| Scratch isolation | New bucket name and state key, proof of no prior ownership/state/backend cache, standalone source commit, default workspace, two separate client directories, and exact six-field backend descriptor. |
| Cost and time | Current priced estimate and ceiling for a second S3 bucket, version storage/requests, a customer-managed rotating KMS key/requests, retained resources, and a staffed maximum runtime. Budget alerts can lag; a ceiling needs an operator stop rule. |
| Custody | Restricted local directories (`umask 077`), separate encrypted copies of bootstrap state and probe-state evidence, version-ID register, access owner and recovery location. Saved plans and state bodies stay private. |
| Failure and retirement | Written blast radius for an unexpectedly allowed bad write/delete, who stops both clients, and a decision to **retain the protected scratch bucket/key** with owner, review date and continuing budget. Deletion is a different approved change; no protection is weakened for cleanup. |

The bootstrap root sets `prevent_destroy` on bucket and key, disables bucket
`force_destroy`, and has no current-version expiration. Consequently a
throwaway bucket cannot honestly be promised at zero residual cost. If the
retained-resource decision is unacceptable, stop and redesign the probe before
AWS access. Do not run `terraform destroy` on the bootstrap root or remove it
from state merely to call the probe retired.

## Preflight and bootstrap: separate approval

1. Perform the separately authorized read-only inventory from
   [foundations readiness](foundations-readiness.md#order-and-approval-boundaries).
   Verify caller/account/Region and current pricing, inspect the proposed
   scratch name and private local state/cache, and confirm no conflicting bucket
   or lineage. An absent object inferred from an error is not proof of ownership.
2. Copy the unchanged standalone root into its own private working directory.
   Supply its five required values in a private variables file; review a saved
   plan showing **only** its bucket, KMS key and protective configurations.
   Capture full native stdout, stderr, exit status and plan hash privately.
3. Obtain approval of that exact plan and cost before applying it. Preserve the
   bootstrap state and an independent encrypted backup. Compare the returned
   backend descriptor with the private client configuration: bucket, key,
   Region, KMS-key ARN, `encrypt = true`, `use_lockfile = true`. Reject extra
   `TF_CLI_ARGS*`, backend overrides, nondefault workspace or mismatched owner.

Even `terraform init` against the real S3 backend is an activation operation,
not a harmless offline probe. The scratch bootstrap and probe-client init are
separate live stages; neither is authorized by this document.

## Controlled client and expected sequence

Prepare two private copies of this **scratch-only** client configuration. The
four descriptor strings belong in an ignored private `backend.s3.tfbackend`
file in each copy, never in the committed block. The client uses Terraform
1.16.5 and only the built-in provider; the application Terraform root is not
involved. Review the exact rendered files before an approved run.

```hcl
terraform {
  required_version = ">= 1.11"
  backend "s3" {
    encrypt      = true
    use_lockfile = true
  }
}

variable "marker" {
  type    = string
  default = "v1"
}
resource "terraform_data" "marker" { input = var.marker }
```

| Stage | Action and expected evidence | Stop if |
| --- | --- | --- |
| Empty-key refusals | Before any client init/state write, send bounded synthetic `PutObject` requests to the **scratch** exact key with (a) no encryption header and (b) a separately approved valid alternate KMS key, then to one wrong path with the approved key/headers. Each attempted case must return a native nonzero access refusal; capture the complete response and verify neither key was created. Use only a harmless synthetic body. An unavailable alternate key is an untested case, not a pass. | Any request succeeds, writes an object, or fails ambiguously for a reason other than access refusal. Preserve the scratch bucket and do not initialize a client. |
| Bind and write | Initialize client A and B independently against the same reviewed six-field descriptor, default workspace only. Plan/apply `marker = "v1"` to the scratch key with a reviewed saved plan. `HeadObject` must show the approved KMS key, a non-null version ID and the exact key. Record that version ID and a private hash of the retrieved state. | Init proposes migration, applies to another key/account, lacks the expected encryption/version metadata, or creates an application resource. |
| Identity/read boundary | After the state exists, the approved owner reads current state into a private file; a named denied principal, if available, and an unsigned request attempt a metadata/read operation on that same object and must be refused. The owner attempts a read at a wrong path and must be refused. This proves effective outcomes, not which IAM/SCP/bucket statement caused them. | A denied caller reads data, or a negative test is inconclusive; never place object bytes in shared logs. If no denied principal is approved, record that identity isolation remains untested. |
| Two-client lock | In client A open **interactive** `terraform console` and keep it at the prompt for at most two staffed minutes. Confirm the scratch `.tflock` exists. While A is open, run client B `terraform plan -input=false -lock-timeout=0s` against the same key. Require a native nonzero **state-lock acquisition** error, not any other failure. Exit A normally; require the lock object to disappear, then B's same plan to succeed. | A loses the session, B acquires the lock, the error is unrelated, or the lock persists after a normal exit. Stop both writers; do not use `-lock=false` or force-unlock. |
| History and restore | Plan/apply `marker = "v2"` from A, capturing the new non-null version ID and protected backup. Read the recorded v1 version by `GetObject` with that ID into a private file; verify lineage and synthetic marker offline without printing state. After both clients have exited and an explicit **scratch restore** approval, copy that version onto the **same scratch key** as a new current version with the approved SSE-KMS key. Verify a third version ID and matching private content hash. A read-only `terraform plan -detailed-exitcode` with v2 configuration should return 2 for the marker difference. | Old-version read, copy, encryption, version/lineage or expected plan result differs. Preserve all versions; do not delete one to restore another. |
| Deletion refusal | Only after backups and an explicit scratch-only blast-radius approval, try ordinary state-key deletion and direct deletion of one recorded version. Both must return nonzero `AccessDenied`, with the current state and all recorded versions still readable. Do not send these requests to the authoritative backend. | Either deletion succeeds or state access changes; stop writers and retain evidence for a separate recovery decision. |

[Terraform documents](https://developer.hashicorp.com/terraform/cli/commands/console)
that an interactive console holds the state lock until it exits; the second
client's [zero lock timeout](https://developer.hashicorp.com/terraform/cli/commands/plan)
therefore provides a bounded refusal check without a sleeping provisioner.
[The S3 backend](https://developer.hashicorp.com/terraform/language/backend/s3)
requires `GetObject`, `PutObject` and `DeleteObject` on the `.tflock` path and
does not need state-object deletion. [S3 `HeadObject`](https://docs.aws.amazon.com/cli/latest/reference/s3api/head-object.html)
reports a current version ID; [versioned copy](https://docs.aws.amazon.com/cli/latest/reference/s3api/copy-object.html)
creates a new current version without deleting the old one. The copy must be
reviewed as a state mutation even in this scratch environment.

The current bucket policy does **not** grant `s3:ListBucketVersions`. Record
version IDs at each controlled write and verify only those known versions; do
not assume the owner can discover arbitrary history later. Full historical
discovery requires a separately reviewed permission/custody design.
[S3 version listing](https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListObjectVersions.html)
requires that action. The runbook's controlled restore proves recovery of a
**known** scratch version, not restoration of unknown history or application
resources.

An unavailable denied principal or alternate KMS key is recorded as **untested**,
never as a passing refusal. Do not declare backend acceptance while a required
identity, key, history-discovery or retirement decision remains unresolved.

## Evidence, stop rules and retirement

For every native command retain complete stdout, stderr, exit code, timestamp,
caller role/account, Region, target bucket/key, client and source commit in
private encrypted evidence before filtering. Keep object bodies, state, plans,
credentials and cached backend metadata out of shared reports. Record the
expected vs observed outcome and version IDs for every phase. A 403 alone is
not enough when the request may have failed for an unrelated reason. Never
report the newest version from a truncated listing or an output tail.

Stop immediately on unknown lineage/ownership, policy or KMS refusal to an
expected operation, unexpected success of a refused operation, lock ambiguity,
lost backup, time/cost ceiling or an unstated principal/path. Preserve native
failures, stop both clients, and make the next repair a separate reviewed
decision. Do not switch to local state, migrate, force-copy, force-unlock,
disable locking, weaken policy or change retention to force a green result.

Retirement of the active **probe session** means both clients exited, no live
lock remains, work directories are secured, all recorded versions/backups are
accounted for, and the retained scratch bucket/key/KMS owner, budget and review
date are recorded. Application teardown never destroys this independent root.
Any later deletion of the scratch resources needs its own written blast radius,
version inventory, policy/protection analysis, saved plan and founder approval;
this procedure does not authorize or prescribe that deletion.

On the real authoritative backend, a separately approved activation may verify
normal binding and native locking only. Do not repeat the scratch fault-injection,
bad writes, deletion attempts, history copy or synthetic lineage there.
