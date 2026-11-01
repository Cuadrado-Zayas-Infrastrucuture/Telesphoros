# Medication recording: close and open without changing images

Date: 2026-11-01. Prepared and rehearsed locally; no AWS plan, apply, migration or deployment was run. Synthetic staging only. These tools preserve the existing MIGRATE/IMAGE/INFRA shapes; they add narrowly checked configuration transitions.

## Commands and review

Use the authorized release checkout pinned to the reviewed commit and the existing private stack configuration and exclusive claim. The scripts still require the expected account/role, canonical variable checksum, running image, clean main checkout and matching state serial/lineage. This document supplies no live authorization.

```sh
CLAIM_OWNER=NAME scripts/staging/release/plan.sh FENCE-CLOSE COMMIT close-001
# Read the saved plan text and the archived source/target variable diff; obtain approval for that exact plan hash.
CLAIM_OWNER=NAME scripts/staging/release/apply.sh FENCE-CLOSE COMMIT PLAN_SHA256 close-001

CLAIM_OWNER=NAME scripts/staging/release/plan.sh FENCE-OPEN COMMIT open-001
# Review and approve the new saved plan separately.
CLAIM_OWNER=NAME scripts/staging/release/apply.sh FENCE-OPEN COMMIT PLAN_SHA256 open-001
```

Operation ids contain 1–48 lowercase letters, digits or hyphens. Every attempt has its own private `releases/COMMIT/fences/OPERATION_ID/` directory: archived `source.tfvars`, generated `fc.tfvars` or `fo.tfvars`, binary plan, readable plan, JSON projection, metadata, an atomic apply-start marker and apply log. Existing attempts cannot be overwritten. Use a fresh id for a later close/open cycle, including repeated operations on the same image/commit. An apply names the same operation and the exact reviewed binary plan SHA-256. A previous apply-start marker blocks a second start even if its log does not yet exist. The detached runner rechecks the saved plan, variable files and archived/current source before apply and before canonical publication; it also hashes the copy before publishing. An edit during rollout holds publication and requires reviewed recovery. Read the final `== apply exit status: N` line; starting the detached process is not success.

Only `medication_writes_enabled` may change in the generated variables; every unrelated byte is preserved. The generator accepts a flat HCL file with a literal boolean assignment, or appends one when absent. Duplicate assignments, expressions, block comments, heredocs and CRLF/NUL input are refused rather than reinterpreted. Stop on an unsupported canonical format; do not bypass its hash or rewrite approval records. Both archived/current source and generated target hashes are checked again at apply. After Terraform exits zero, the target and its checksum become canonical. A failed apply leaves canonical variables unchanged, but may have partly changed cloud state: preserve the claim/evidence and inspect before planning again.

## Exact plan shape

Both image variables and all container images must stay at the currently running, digest-pinned staging image. The plan must be complete, applicable, error-free, without drift or changed outputs. Only the API task-definition replacement and its service's task-definition reference may change. Capacity and steady-state waiting remain in force. CPU, entrypoint, other environment values, secrets, permissions, worker definitions, other services and unrelated resources cannot change. Unknown fields outside the task's generated identifiers/revision and service task-definition reference hold. A secret/environment file that could override the medication setting holds.

`FENCE-CLOSE` changes enabled to disabled, or installs an explicit disabled value when missing. Already disabled/no-op plans are refused. Installation may be needed before MIGRATE so that adding the environment field no longer rides along with a migration-only plan. An old binary may ignore that field: installation is not proof of a functioning fence. Verify the artifact and behavior; do not call the initial old-image normalization a completed medication or global write drain.

`FENCE-OPEN` requires an explicit disabled value in the previous definition. Both planning and applying require this commit's existing release directory to record: the running image in `new_image.txt`, a signature-verification record covering that digest and staging signing key, successful `i-apply.txt`, and `migrate-status.txt` reporting no pending migration. The metadata check does not rerun cosign, authenticate the record or prove live migration/task state. Perform the existing signature and live-state verification procedure. It rejects empty verification markers, unsigned/break-glass records, other images/keys and incomplete release records. It cannot open an unrelated running release merely because a newer tooling commit is checked out; use the reviewed release context or prepare another coordinated release, never fabricate prior-completion evidence.

## Cutover and drain boundaries

1. Verify the live target/identity, backup/recovery point, exclusive release claim and actual pending changes. Review a global maintenance procedure covering all patient-affecting API, worker, import and direct database writers before breaking migration 0066.
2. If necessary, separately review/apply the close/explicit-setting installation plan. Confirm every serving task's artifact and setting, check both running- and stopped-desired-status inventories with the [observation checker](medication-fence-rollout-check.md), and probe medication POST behavior through the authorized synthetic path. A flag change affects replacement tasks; old admitted requests may still finish. Drain them and account for load-balancer deregistration and active transactions before making a fence claim. Keep the broader maintenance controls in place.
3. Use the existing separately approved MIGRATE/migration and coordinated IMAGE procedures. Keep recording closed until API, worker and verifier versions, grants, ledger, source-list alignment and actual migration state are confirmed. The new modes do not change those procedures or excuse another resource change.
4. Verify closed-state behavior and authorized reads, then review a separate open plan only after the coordinated release has completed. Confirm the resulting tasks and synthetic add/correct/stop/history/retry/tenant/role/ledger checks through the maintenance procedure's approved test path. If that path cannot safely exercise synthetic writes while ordinary writers remain controlled, stop and revise the operational plan.
5. Reopen broader traffic/writers only after the approved acceptance gates. Monitor and update the authoritative applied-state records only from real observations. New medication events still make a blind migration down/old-verifier rollback unsafe; use the existing forward-repair/explicit-restore decision process.

The local request rehearsal uses real PostgreSQL locking: an enabled API admits a request, its INSERT waits, and a disabled replacement refuses another POST. Releasing the lock lets the old request commit; its ledger verifies, then the old API closes and the disabled replacement remains read-only. This proves why replacement settings alone do not drain old work. It does not establish ECS signal handling, load-balancer behavior, a global write fence or any live cutover. Those remain required operational observations.
