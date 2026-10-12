# L1 synthetic storage and access verification

Scope: the founder approved L1 and refinement proposals 17/18 on 2026-10-11. The feature branch is `feat/local-storage-intake`, based on `aa912254a6d5f4f283a379316b43255e3dd4316d`. L2 browser implementation and L3 product setup/scheduler/teardown remain pending. G01 remains open; clinical use and AWS/provider/spending/agreement actions remain deferred.

Draft PR #77 was subsequently authorized and opened. Its first combined-tree CI run exposed two verification-fixture gaps: the PostgreSQL-only upload journal suite was outside the existing `test/db` service tier, and the image rehearsal had no S3 endpoint/versioned bucket for processing-disabled startup. The journal suite now lives in `test/db` with all assertions preserved. The existing image rehearsal explicitly uses its disposable Moto endpoint and creates/verifies a versioned bucket before API startup; no application startup check was weakened. Current main `9c66493` was integrated, retaining merged #73–#76. These are L1 CI repairs, not L3 product setup or teardown. Final remote results belong to the PR checks and dated delivery receipt; the table below retains its original local-baseline results.

The subsequent full-history secret scan flagged the fake Secrets Manager resource name `synthetic/migrator` as a generic API key. An exact-value, exact-file, exact-rule exception allows only this identifier; generated credential controls in the same file and the same identifier in a foreign file still fail the scan. No real credential is stored or suppressed. The repaired no-service profile passed 1,222 tests (201 expected later-tier skips), four PostgreSQL journal controls passed, and the full container rehearsal plus 20 image/readiness guards, typecheck and lint passed locally.

## Implemented behavior

- Owned local mode accepts opaque PDF/VCF/JSON through bounded private staging, streaming structural/hash/size checks, conditional single-part upload, exact-version read-back and atomic metadata/journal completion.
- Immutable attempt identity and report revision guard replay, concurrent changes and cancellation. Lost write/commit replies retain durable state; resume reconciles without a second PUT.
- A separate operations library conservatively compensates abandoned owned versions and receipted multipart uploads. Missing ownership, incomplete version/multipart/evidence inventories, unavailable database reads, holds and protected references prevent deletion. Safely empty cancelled attempts release quota only after both inventories and staging disposal are confirmed.
- Authorized file links verify the pin and sign attachment/private-no-store responses independently of clinical processing. The registered source type freezes after upload.
- `LOCAL_STORAGE_RUN_ID` requires clinicaloff, non-production, disposable loopback database/bucket identities and dummy S3 credentials. Existing browser VCF/JSON transport outside this mode remains under the separately approved compatibility boundary; legacy PDF transport retains its processing gate.

See [API and bounds](../design/local-storage-intake.md) and [verification blast radius](local-storage-intake-blast-radius.md). No existing pilot databases, review runner, shared Moto state or OpenEMR containers were reset.

## Verification

Pinned arm64 macOS Node 22.22.0 / Unicode 16.0, pnpm 10.28.0, PostgreSQL 16.14 and Moto 5.2.3. Real database checks use the restricted application role, forced RLS and SCRAM password authentication. Services were created exclusively for this verification and contain synthetic fixtures only.

The full sequential three-tier regression passed:

| Check | Result |
| --- | --- |
| Backend on memory, with service specs available | 1,710 passed; 201 intentional later-tier skips |
| Backend API on PostgreSQL | 1,891 passed; 20 intentional S3-specific skips |
| Backend API on PostgreSQL/S3 | 1,911 passed, 132 suites; zero skips/failures |
| Other workspace tests / build orchestration | 411 / 8 passed |
| Existing browser foundation / upload development | 54 / 18 passed |
| Workspace typecheck, lint, build | passed |
| CI / infrastructure / image configuration guards | 35 / 31 / 19 passed |
| Frontend chunk budget / production knowledge loader | passed; knowledge contains zero guidelines |

Two additional cancellation/MIME controls were added after that matrix without an implementation change. The focused intake/fault suites passed 28 assertions in each of the memory, PostgreSQL and PostgreSQL/S3 profiles (84 assertions total). They confirm cancelled lost-write reconciliation never pins or issues a second PUT, and raw MIME mismatch refuses before writer leasing/storage. Recovery artifact validators passed for all three pre-commit profiles. Regenerate those profiles after committing and require their recorded git heads to match `HEAD`; pre-commit evidence is not a claim about the final commit or remote CI.

The PostgreSQL/S3 streaming artifact recorded two concurrent 10 MiB synthetic PDFs (20,971,520 bytes), 243.762 ms, 43,286,528 bytes of peak RSS increase and a nine-byte maximum concatenation, below the 96 MiB/256 KiB limits. The aggregate-only artifact is `apps/backend/test-results/local-intake-memory-postgres-s3.json`, an ignored local test output.

Observed repairs retained negative controls: migration/schema acceptance and old route-owner expectations were updated for 0015 and the storage/processing split; raw socket cleanup captures the socket because `req.socket` may be null after response completion; corrupt-version controls own fresh fixtures; environment parser controls use raw values. A diagnostic run overlapping a direct SMART dependency rebuild with F3 subprocess compilation failed F3 setup (the other 1,898 assertions passed). Sequential F3 and all three final tiers subsequently passed; no unrelated build-coordination code changed.

Focused controls exercise syntax/UTF-8/parser limits, exact lengths/checksums, raw chunked bodies, simultaneous 10 MiB streaming, idle/minimum-rate deadlines, slot refusal/reuse, registration/declaration replay, tenant/role/revision refusal, pin/cancel/cleanup races, lost S3/database/delete replies, protected soft-deleted/catalogue references, legal-hold/retention response refusal, foreign ownership, unknown multipart state, default and shortened grace, RLS/FK/ACL invariants, listing cursors/caps, private staging and interrupted-file reconciliation.

The cleanup hold/retention refusal test injects protected HeadObject responses around real PostgreSQL/Moto objects. It verifies fail-closed local code; it does not establish provider-enforced Object Lock or IAM custody. The existing recovery/clinical regression suites remain isolated and explicitly enabled only within their own synthetic fixtures. The new L1 apps retain clinicaloff and no reader/knowledge/runner providers.

Commands match existing package scripts:

```sh
pnpm typecheck
pnpm lint
pnpm build
pnpm test
TEST_STORAGE=postgres pnpm --filter @telesphoros/backend test
TEST_STORAGE=postgres TEST_OBJECT_STORAGE=s3 pnpm --filter @telesphoros/backend test
pnpm --filter @telesphoros/frontend e2e
pnpm --filter @telesphoros/frontend check:chunks
pnpm test:ci-config
pnpm test:infra
pnpm test:image
pnpm --filter @telesphoros/backend knowledge:verify --production
node .github/ci/verify-recovery-metrics.mjs
node .github/ci/verify-application-recovery.mjs
```

Supply the owned loopback `TEST_DATABASE_URL`/`TEST_S3_ENDPOINT`, PostgreSQL 16 client tools, explicit dummy credentials and installed browser runtime. Keep workspace commands sequential: bypassing the workspace launcher while separately rebuilding shared packages can remove declarations needed by a recovery subprocess. No application credentials or signed URLs belong in retained records.

## Limits and follow-ups

- Structural checks do not certify malware-free or clinically valid content; files remain opaque and downloads are attachments.
- Two-intake/RSS observations include the test client, SDK and read-back. They are local regression limits, not production sizing or RTO evidence. A kernel-blocked filesystem write is detected when the write returns; no hardware cancellation guarantee is claimed.
- L1 supplies cleanup/staging primitives and durable status, without an operational schedule or trusted run manifest/catalogue adapter. L3 owns those integrations, clock checks, multipart assembly and complete Moto/IAM-state teardown.
- L2 must replace the old browser transport before the UI can target owned validated-intake mode. Existing browser acceptance checks cover compatibility, not a new L2 user flow.
- Draft PR #77 is authorized; remote acceptance requires all seven combined-tree CI checks and recovery artifacts. Production coverage, custody, contract fit, real records and deployment remain separate gates.
