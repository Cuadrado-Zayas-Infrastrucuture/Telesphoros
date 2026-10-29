# F3 application recovery — synthetic library rehearsal

The [F3 plan](../design/plans/f3-application-recovery.md) defines the acceptance boundary. F2 #63 is merged; its [final CI evidence](../verification/f2-independent-recovery.md#merged-delivery-evidence) passed all seven checks. F3 adds an opt-in application storage adapter and a fresh-process rehearsal. No recovery CLI, production activation or provider drill exists in this slice.

## Trusted loader handoff

1. Verify a specific authenticated format 2 DB restore and its complete inventory, including soft-deleted evidence.
2. Verify F1 completion/catalogue against that recovery point and every independent object. Stage into a separate application bucket, resolving uncertain writes without blindly repeating them.
3. Create an encrypted/authenticated installed catalogue with original source identities and exact installed destination VersionIds. Reuse the existing catalogue crypto. Keep the independent retained catalogue/completion separately.
4. Call `RecoveryObjectStorage.open` with independently derived expected DB binding/inventory/bucket/prefix and a separately configured S3 application read port. The factory verifies all required installed bytes before returning a provider. Do not derive expected values from the document being verified.
5. Pass the initialized provider to `AppModule.register(env, provider)`. Administrator, loader/copy credentials and catalogue keys stay outside the returned provider. The application storage credential reads its application bucket only; it cannot read recovery custody storage or write files.

The test helper performs this handoff inside the fresh recovery worker. A real operational entry point, durable encrypted handoff destination, custodied key retrieval and live policy/permissions remain separately scoped. `main.ts` does not automatically enable recovery mode. Normal application configuration and production/clinical holds still apply.

## Read behavior

The DB's original PDF version remains immutable. The resolver checks the original key/logical version, reads the mapped target key/exact version, checks actual bytes/metadata and returns the original logical version to existing callers. Authorized PDF/text URLs bind target versions after a new verification read. Text and completed unpinned JSON use the observed verified identity. Unknown/ambiguous identities and missing/corrupt bytes refuse; no latest fallback, primary reads or recapture substitution.

Recovery file storage is read only. New uploads and text writes return a fixed 503. Restored decisions/evaluations continue using the restricted database role and existing ledger guards. Standard reports are checked through existing metadata APIs and injected application storage; no new standard-report download route is claimed.

## Available verification commands

Use pinned Node 22.22.0, pnpm 10.28.0 and PostgreSQL 16 tools. Set `TEST_DATABASE_URL` and `TEST_S3_ENDPOINT` to disposable loopback PostgreSQL/Moto services; missing services are skips, never acceptance. PostgreSQL uses SCRAM, and each worker gets a canonical private native-dependency cache with HOME/XDG/ambient provider credentials absent.

```bash
pnpm --filter @telesphoros/backend test --runInBand --runTestsByPath test/recovery-object-storage.spec.ts
pnpm --filter @telesphoros/backend test --runInBand --runTestsByPath test/db/application-recovery.pg-spec.ts
TEST_STORAGE=postgres pnpm --filter @telesphoros/backend test --runInBand --runTestsByPath test/db/application-recovery.pg-spec.ts
TEST_STORAGE=postgres TEST_OBJECT_STORAGE=s3 pnpm --filter @telesphoros/backend test --runInBand --runTestsByPath test/db/application-recovery.pg-spec.ts
node .github/ci/verify-application-recovery.mjs
pnpm build
pnpm lint
pnpm typecheck
pnpm test:ci-config
```

The validator requires all three generated profiles at the current checkout. CI runs the full backend service suite in each profile, then validates and retains `application-recovery-measurements` for seven days. Artifacts contain tested commit, fixed control names, physical DB/archive/catalogue/evidence byte denominators with GB/GiB, monotonic F2 phase times and application verification duration/link bytes. No content, identifiers, keys, paths, signed URLs or resolved credentials are retained. Failed/incomplete profiles cannot pass the gate.

F2 `restoreAndEvidence` includes the F3 callback when used by F3. `evidenceVerification` covers byte staging only; application duration covers provider setup/API/reader checks through final inventory verification, excluding final app/client cleanup. Total excludes final restore/temporary cleanup. Small synthetic datasets cannot establish production RTO.

## Remaining gates

See the [founder deployment checklist](../design/plans/report-file-recovery.md#founder-deployment-gates--required-before-f4). Moto and the synthetic gateway prove neither AWS Compliance/IAM/KMS nor signature enforcement/native replication/custody. Provider retention must protect already issued links; wrong or lost keys and operator compromise require a separately verified custody model. Abrupt termination cleanup, live backfill/freshness/lag and production RPO/RTO remain unproved. No clinical approval follows from recovered bytes or green CI.
