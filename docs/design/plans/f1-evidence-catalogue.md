# F1 authenticated evidence catalogue — approved local slice

Founder approved implementation with “go” on 2026-10-10 after reviewing the concrete local F1 plan. Base main `2b96033` (merged #61); branch `feat/f1-evidence-catalogue`. One independent draft PR. Work proceeds sequentially.

## Objective and completion criteria

Produce a separately encrypted/authenticated catalogue tied to a verified format 2 DB restore, covering every completed PDF/VCF/JSON and captured text reference, including soft-deleted reports. Freeze observed source identities before copying; publish completion only after exact destination bytes and version-bound policy metadata verify. Real PostgreSQL/Moto healthy and refusal controls, aggregate-only CI artifacts, build/type/lint and required CI must pass.

| Step | Prerequisite | Scope and deliverable | Verification |
| --- | --- | --- | --- |
| F1.1 contract | Reviewed design | `db/evidence-catalogue.ts`; strict schemas, DB binding, separate authenticated domains/key | Contract/crypto specs |
| F1.2 inventory | F1.1 | Restore callback and read-only snapshot inventory | Real PostgreSQL, numeric pagination, restricted-role refusal, cleanup |
| F1.3 producer | F1.2 | Ops-only S3 port, immutable checkpoints, bounded discovery, translated copies and completion | Actual Moto protocol and exact read-back |
| F1.4 controls | F1.3 | Interrupted/lost-reply resume, mapping/key/policy/corruption refusals, healthy controls | New focused specs and backup/ledger regressions |
| F1.5 delivery | F1.4 | Aggregate JSON CI artifact, runbook/status and draft PR | Full backend, CI guards, exact-head CI/log/artifact inspection |

## Scope and contracts

- Reuse existing crypto, backup/restore, cleanup, TLS and synthetic fixture helpers. Keep format 2 backups and DB schema unchanged; no new dependency or app storage provider.
- The producer itself restores/verifies a new owned database and reads membership before dropping it. It accepts no caller assertion of verification and never inventories the unrelated live source DB.
- PDFs require the DB's real version pin. Unpinned VCF/JSON/text resolve only hash/content-type/size/scalar matches; historical discovery is exhaustive when needed. Record observed `null`/unversioned state honestly. No fake PDF pin, latest substitution or recency claim.
- Immutable encrypted checkpoint freezes membership, DB binding, source versions, generation, destination and policy. Resume verifies checkpoint membership against the same verified restore, then re-reads frozen source and existing destination versions. Foreign/duplicate/deleted stage versions refuse; lost replies trigger discovery/read-back, never blind PUT retry.
- Destination version metadata and bytes come from the same exact GET. Require supplied COMPLIANCE expiry and encryption/key identity; no retention duration is selected as a clinical/legal policy. Completion is encrypted/authenticated and published last.
- Fixed error codes/messages and aggregate artifacts exclude identifiers/content/URLs/credentials. Do not log returned catalogue objects: their encrypted membership is confidential even for synthetic development.

## Software bounds

One worker. Aggregate caps: 1,000 listing pages, 10,000 examined versions/keys, 10,000 references, 16 MiB signed catalogue, 1 GiB consumed read plus attempted write payloads. Terminal page 1,000 succeeds; truncated page 1,000, missing/repeated cursors and listing timeouts throw `IncompleteEvidenceListingError`. No partial-list fallback. These are ceilings, not promised dataset capacity.

S3 requests include body consumption in a 30-second deadline; transient reads have at most three attempts. Writes are not automatically retried. PostgreSQL inventory uses query/statement timeouts; `pg_restore` has a process timeout. A monotonic 15-minute run budget is checked between operations/phases; local file hashing/encryption and owned cleanup are not preempted mid-operation. Callers can lower limits, never raise them. No scheduler or external automatic repair loop is installed.

## Exclusions and founder gates

F2 primary-denied byte recovery, F3 app resolver/acceptance, F4 provider/custody/permission/retention drill, production CLI, scheduling, IAM/Terraform, live AWS, PHI, deployment and spend remain separate. No graphs/subagents were authorized. The uncommitted workflow setup in the prior worktree stays untouched. Founder review of this PR precedes F2; all [deployment gates](report-file-recovery.md#custody-operational-and-cost-gates) remain open.

Repairs must follow observed failures; focused checks during iteration, required integration checks before completion. After three unsuccessful repairs, repeated identical failures without new evidence or no progress, reassess and classify implementation/environment/requirements/permissions. Stop only when an absent decision/authorization blocks this approved slice.

See [runbook](../../ops/evidence-catalogue.md) and [verification](../../verification/f1-evidence-catalogue.md).
