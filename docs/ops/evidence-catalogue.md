# Local F1 evidence catalogue library

F1 is an operations library, not a CLI, app recovery resolver, scheduler or production deployment. Its entry point is `produceEvidenceCatalogue` in [evidence-producer.ts](../../apps/backend/src/db/evidence-producer.ts). The existing `db restore` CLI is unchanged. Full design: [report-file recovery](../design/plans/report-file-recovery.md); scope: [approved F1 plan](../design/plans/f1-evidence-catalogue.md).

## Inputs and publication

Supply an explicit administrative target-server URL for a new throwaway restore, local authenticated format 2 backup directory/key file, independently supplied catalogue key file, generation, source/destination ops storage ports, and explicit COMPLIANCE expiry/encryption policy. The S3 port requires explicit credentials and fixed buckets/prefixes; it is not registered in the app module. Never pass production data to this local rehearsal.

The producer verifies the restored DB (including schema, privilege and ledger checks), reads all completed/soft-deleted membership inside that owned restore, and drops it. Uncompleted registrations and unreferenced current text keys are counted separately; they are never promoted into evidence or deleted.

A destination generation holds `checkpoint.enc`, `objects/<source identity digest>`, `catalogue.enc` and final `completion.enc`. The three documents use the existing authenticated encryption format with a separate key and authenticated message domains. Copy mappings bind each source identity to one exact translated destination version. Generation keys are conditional/append-only; ambiguous history refuses resume. Reusing the same generation/DB binding/policy re-verifies frozen identities and existing copies without writing again. Changing membership/policy requires a new generation; never delete retained generations to retry.

Exact-version GET binds verified bytes, version, retention and encryption metadata in one response; AWS documents these [GetObject fields](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html). Moto exercises that protocol, not actual AWS lock/IAM/KMS enforcement. Destination-admin custody isolation and native replication remain unproved. F1 still reads primary on resume: primary-denied recovery belongs to F2.

## Refusals and bounds

Typed `EvidenceError` uses fixed codes; `IncompleteEvidenceListingError` covers incomplete discovery. Missing/repeated cursors, a truncated aggregate page cap, timeouts, missing exact pins, wrong bytes/content type/scalars, altered membership, foreign/duplicate mappings, wrong/missing keys and insufficient policy metadata prevent a new completion. Existing completion is never treated as an unverified shortcut. An oversized unrelated unpinned version can be skipped while searching historical matches; aggregate exhaustion still aborts.

See the [software bounds](../design/plans/f1-evidence-catalogue.md#software-bounds). The run budget is checked between phases/operations; local crypto/file work and cleanup are not forcibly interrupted. Catalogue temp files and restore DBs use existing ownership/cleanup helpers. Storage clients are owned by the caller: call `destroy()` in its `finally` block. An uncertain write is recovered only by exact stage discovery/read-back. No automatic operator remediation runs.

## Available verification commands

Use pinned Node 22.22.0, pnpm 10.28.0, PostgreSQL **16** client tools and the existing Moto fixture. Set `TEST_DATABASE_URL` and `TEST_S3_ENDPOINT` to isolated helper-owned loopback services; synthetic fixtures only. Missing services skip the PG/producer controls, which is not acceptance. The specs are present in this slice:

```bash
pnpm --filter @telesphoros/backend test --runInBand --runTestsByPath test/evidence-catalogue.spec.ts test/s3-evidence-storage.spec.ts test/db/evidence-catalogue.pg-spec.ts
pnpm --filter @telesphoros/backend typecheck
pnpm --filter @telesphoros/backend lint
pnpm --filter @telesphoros/backend build
pnpm test:ci-config
```

Required CI retains existing three service tiers: default memory API with real PG/S3 specs; `TEST_STORAGE=postgres`; then `TEST_STORAGE=postgres TEST_OBJECT_STORAGE=s3`. No F2–F4 commands or file-recovery CLI exist.

## Aggregate measurement artifacts

The new PostgreSQL/Moto spec writes ignored `apps/backend/test-results/evidence-catalogue-{memory,postgres,postgres-s3}.json`. CI uploads `evidence-catalogue-measurements` for seven days, including failures; absence of files errors. Test assertions and existing CI failure/skip gates determine acceptance. Download/retain these artifacts for historical review; stdout alone is insufficient.

Whitelisted output includes status/control names, actual checkout SHA, sanitized runtime/storage assumptions, exact source/restored **physical DB** bytes, encrypted archive/catalogue bytes, unique required PDF/JSON/text payload bytes and counts, verified copied bytes/counts, and monotonic phase/total durations. Volumes carry bytes, decimal GB and binary GiB. `read` counts consumed response payloads (including repeated verification); `writeAttempted` counts submitted payloads (including uncertain replies), **not measured network traffic**. A successful no-write resume still verifies all five fixture objects. Physical DB size, encrypted archive size and object payload volume are different denominators.

No raw catalogue/binding, tenant/report IDs, object keys, report content, URLs or credentials enter the artifact. `gitHead` is the tested checkout: on PR CI this may be GitHub's merge commit; pair it with the run's PR head metadata. `independentBytesRecovered` and `applicationRecoveryComplete` remain false. Tiny synthetic timings establish neither production RTO nor RPO. Live F4 evidence needs its separately approved controlled destination.
