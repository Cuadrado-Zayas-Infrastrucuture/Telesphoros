# F2 independent-byte recovery rehearsal

This is a synthetic test harness, not an application resolver or recovery CLI. It extends [F1's catalogue](evidence-catalogue.md) using existing authenticated DB restore and exact-version storage helpers. Scope: [approved plan](../design/plans/f2-independent-recovery.md).

## What runs

The parent builds synthetic PDF/VCF/JSON/text fixtures and authenticated catalogues. A read-only recovery gateway denies primary storage and copy writes; a distinct loader can write only the fourth, owned recovery-target bucket. Each probe runs in a new Node process and fetches the DB backup from its separate backup bucket. It restores and verifies the database, checks catalogue membership against that verified restore, verifies each signed copy version, installs the bytes into the recovery target and verifies its exact target version.

All five fixture objects must succeed: two PDFs (one soft-deleted report), unpinned completed VCF/JSON and captured Unicode text. Historical source bytes are frozen by F1 despite newer versions/delete markers. Newer destination bytes never substitute for signed pins. Missing required bytes, partial completion, corrupt text/catalogue, omitted soft-deleted membership, invalid mappings, foreign tokens, wrong/missing keys and policy failures refuse.

Interrupted recovery leaves verified target stages for a fresh-process resume. Lost write replies resolve through discovery/read-back, never blind retry. Every completed or refused worker is checked for zero primary requests, read-only copy/backup access, unchanged target database inventory and no owned downloaded/decrypted temp files.

## Commands available in this slice

Use pinned Node 22.22.0 and pnpm 10.28.0, PostgreSQL 16 server/client tools and Moto. Set `TEST_DATABASE_URL` and `TEST_S3_ENDPOINT` to disposable helper-owned loopback fixtures; set `PGBIN` if PostgreSQL 16 server tools are not the default. Missing services mean skipped work, not acceptance.

```bash
pnpm --filter @telesphoros/backend test --runInBand --runTestsByPath test/independent-recovery.spec.ts test/db/independent-recovery.pg-spec.ts
pnpm --filter @telesphoros/backend test --runInBand --runTestsByPath test/db/recovery-cli.pg-spec.ts test/db/evidence-catalogue.pg-spec.ts
pnpm --filter @telesphoros/backend typecheck
pnpm --filter @telesphoros/backend lint
pnpm --filter @telesphoros/backend build
pnpm test:ci-config
```

## Structured evidence

The spec writes ignored `apps/backend/test-results/independent-recovery-{memory,postgres,postgres-s3}.json`. The database CI job validates all three profiles against the actual checkout SHA, strict field whitelists, volumes, control counts and honest flags, then retains `independent-recovery-measurements` for seven days, including failures; absent artifacts error. Expected healthy output has 30 recorded controls and seven recovery measurements. Test assertions determine acceptance; an incomplete artifact does not pass.

Whitelist: fixed control names/status, tested checkout SHA, sanitized runtime assumptions, exact source/restored physical DB bytes, encrypted archive/catalogue bytes, required/recovered payload bytes and counts by kind, consumed read/attempted write volumes and monotonic phase durations. Every volume includes bytes, decimal GB and binary GiB. No raw tenant/report IDs, keys, catalogue, signed URLs or credentials are serialized. `restoreAndEvidence` includes evidence installation and verification; `total` excludes final owned cleanup. Read/write totals count application payloads, not measured network traffic.

`databaseRecoveryVerified=true` and `independentBytesRecovered=true` apply only to a passed fresh-process translated-copy measurement. `applicationRecoveryComplete=false` and `nativeReplicationVerified=false` remain explicit. Tiny synthetic volumes establish no production RPO/RTO.

## Limits

Moto headers and the synthetic permission gateway do not prove actual Object Lock Compliance, KMS, AWS IAM, native replication or custodian separation. The native identity contract is unit-tested, not exercised against replicas. Fault injections remain in the test worker. Cooperative interruption cleanup is verified; abrupt termination/power loss is not. Recovery stages are retained, never deleted to retry. F3's restricted application/file-link acceptance, F4's live provider/custody drill and all founder deployment gates remain pending.
