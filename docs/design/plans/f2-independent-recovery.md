# F2 independent-byte recovery — approved synthetic slice

Founder approved on 2026-10-10 after the phase reconciliation and concrete seven-line plan. Base main `3c1e191` (merged #62); branch `feat/f2-independent-recovery`. Sequential work; no agents or dependency graph.

## Objective and completion criteria

Prove a fresh process can download an authenticated format 2 DB backup, verify the restored schema/privileges/RLS/ledger and complete catalogue membership, and recover every required report/text byte with primary storage denied. Install and read back exact bytes in a separate recovery bucket. Required refusal controls, healthy controls after faults, integration regressions and aggregate CI artifacts must pass. Application recovery remains false.

| Step | Scope / deliverable | Verification |
| --- | --- | --- |
| Merge gate | Add only the missing `image` required check to the existing active GitHub ruleset | Compare full before/after rules; read effective main checks |
| Recovery fixture | Test-only process, scoped gateway and recovery probe; reuse F1 crypto, inventory, storage, verified restore and existing target helper | Real loopback PostgreSQL 16/SCRAM and Moto |
| Controls | Historical source bytes, exact copy pins, all report kinds/soft deletion, missing/corrupt/foreign/stale/incomplete state, keys/policy, interruption/resume, listing bounds | Fresh workers; no primary requests, read-only copy credentials, exact target read-back, owned DB/temp cleanup |
| Evidence | Aggregate-only volume/timing JSON, CI artifact, runbook and verification record | Required service tiers and actual artifacts; no raw catalogue or identifiers |

## Contracts and boundaries

- Primary, independent copy, recovery target and DB backup are four distinct buckets. The synthetic gateway permits the copy reader only GETs on copy/backup; a separate loader may GET/PUT only its recovery target. Explicit denied primary reads and copy writes must fail before acceptance.
- The recovery worker receives locators, policy and key-file paths over private IPC. It receives no source client, producer result, cached report bytes or local backup path. Its environment excludes ambient cloud credentials and the direct emulator endpoint.
- Authenticate the backup manifest, completion and exact catalogue version; match the DB recovery-point binding and every restored reference, including soft-deleted rows. Counts alone are insufficient.
- Translated copies use signed source-identity-to-destination-version mappings and stage tokens. The native original-key/version contract is unit-tested separately; Moto does not prove native AWS replication. This fixture refuses native mappings in its translated recovery path.
- Recovery target stages are conditional and verified by bounded discovery plus exact-version read-back. Lost PUT replies do not trigger blind retry. Partial target stages are retained and reused only after verification; they never mean application acceptance.
- Simulated provider/document faults are test-only, including authenticated semantic mutations, missing exact pins, policy drift and pagination. Healthy byte transfer uses actual S3 HTTP and PostgreSQL restoration. The gateway checks caller identifiers/allowed operations, not AWS signatures or IAM.

## Bounds, repair loop and cleanup

Reuse F1's 1,000 aggregate listing pages, 10,000 versions/references, 16 MiB documents, 1 GiB consumed read plus attempted write payloads, bounded requests and monotonic run budget. A terminal listing page 1,000 is valid for discovery; a recovery needing subsequent target listings still refuses exhausted aggregate budget. Truncated page 1,000, missing/repeated cursors and timeouts refuse without acceptance.

Each fresh worker has a 120-second harness ceiling. Cooperative interruption is injected after the first target object; normal error cleanup drops the owned restore and removes downloaded/decrypted temporary files. Abrupt process termination/power-loss database cleanup is not proved by this slice. Fixture target shutdown precedes removal; only generated task-owned synthetic resources are cleaned.

Repairs follow observed failures. After three unsuccessful attempts, identical failure without new evidence or no progress, reassess and classify the blocker. Initial fixture errors were reassessed against existing patient constraints and the CLI rehearsal's built-in-role handling. No production invariant was relaxed.

## Exclusions

No F3 application resolver, F4 custody/provider drill, production reader/clinical behavior, DB schema/backup format, CLI, scheduler, IAM/Terraform, AWS apply, real records, deployment or spend. Live `image` protection was separately approved as the first action; every other existing ruleset field was preserved. See [runbook](../../ops/independent-recovery.md) and [verification](../../verification/f2-independent-recovery.md).
