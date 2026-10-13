# T02 strict migration readiness

Implementation on `fix/readiness-migration-history`, based on main
`d7569aa7ac33aa3b37871a486f85ed72e0f12fc0`. The founder initially authorized
the focused fix and real PostgreSQL verification, then authorized commit and
draft PR delivery on October 13, 2026. Merge and deployment remain excluded.
The local results below were captured before committing; PR checks are reported
separately against the committed head.

## Implemented

`pendingMigrations()` now delegates to the existing `migrationStatus()` validator,
then returns the pending version strings. This removes the weaker set-difference
path without duplicating validation rules. Database/readiness comments document
the throwing contract. No SQL migration, grant, dependency or infrastructure code
changed.

The actual route is `/api/v1/ready` → `ReadinessService` →
`migrationsAppliedCheck` → `Database.pendingMigrations` → `pendingMigrations`.
Unknown/non-prefix history and checksum drift now yield the existing generic 503
response. Healthy history returns 200. `/api/v1/health` remains 200 during these
faults, and the same running application becomes ready after fixture repair.

## Controls and regression proof

All database mutations were confined to a newly owned PostgreSQL 16.14 cluster
on loopback port 55483 and generated synthetic databases. Moto 5.2.3 on port 5559
provided local object storage for the broader suites. Node 22.22.0 and pnpm
10.28.0 used the frozen lockfile. No existing review service, production database,
AWS resource or real record was used.

Before changing production source, two new HTTP regressions ran on real PostgreSQL:
checksum drift and an unknown newer version both incorrectly returned 200 where
503 was expected. That run had **4 passed, 2 failed, 0 skipped**. The production
diff was empty at that point; the regression patch and source hashes were retained.
After the fix, the focused four-suite run had **41 passed, 0 failed, 0 skipped**.

| Real PostgreSQL control | Observed behavior |
| --- | --- |
| Healthy history | Helper `[]`; readiness 200 |
| Missing history table | Pending shipped versions; readiness 503; probing creates no table |
| Pending suffix / middle history gap | Pending suffix / `MigrationError`; HTTP 503; exact fixture restoration returns 200 |
| Checksum drift / unknown newer version after startup | Generic migrations 503; no internal sentinel/details exposed; liveness 200; repair returns 200 without restart |
| Runtime role | Non-owner, no superuser/BYPASSRLS/CREATEDB/CREATEROLE; history SELECT only; UPDATE denied with 42501 |
| Read-only transaction | Healthy and invalid history evaluated without writes |
| Changed up SQL / changed down SQL / missing pair | Each temporary artifact rejected; shipped artifact remains healthy |
| Revoked history SELECT | Generic 503; existing grant restoration returns 200 |
| Actual exclusive metadata lock | HTTP 503 within the existing deadline (test bound under five seconds); liveness 200; rollback restores readiness |
| Database disappears | Existing generic failure envelope and liveness controls pass |

## Compatibility boundary

| Binary / database history | Strict result |
| --- | --- |
| N / N | Ready |
| N+1 / N | Pending migration; not ready |
| N / N+1 | Unknown migration; not ready, even for an additive change |
| N+1 / N+1 | Ready |

The matrix used an actual additive migration in a disposable copy of the migration
directory and a disposable database. Both SQL directions participate in the
checksum. There is no compatibility allowlist or bypass.

This validates recorded version/checksum history; it does not attest to the
physical schema, migration-name field, migration execution order by timestamps or privileged
tampering that changes history and schema together. The existing two-second
readiness race bounds the response but does not cancel the underlying query.
Startup and direct request admission are unchanged. Preflight candidate artifacts
before any separately authorized rollout; do not rewrite history to silence drift.

## Broader verification

The first full memory profile had 1,719 passing tests and eight setup failures in
the existing stored-PGx suite: its 60-second `beforeAll` deadline expired during a
concurrent workspace build. All eight passed in isolation with unchanged
timeouts. With no concurrent build, the full profile passed 1,727 tests (201
profile-specific skips). This is consistent with build/resource contention;
the exact cause of the initial timeout was not conclusively isolated. The failed
run remains part of the receipt rather than being discarded.

| Final check | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| Focused migration/readiness (4 suites) | 41 | 0 | 0 |
| Memory application storage, real PG/Moto services | 1,727 | 0 | 201 |
| PostgreSQL application storage, real PG/Moto services | 1,908 | 0 | 20 |
| PostgreSQL/S3 application storage, real PG/Moto services | 1,928 | 0 | 0 |
| Image configuration guards | 19 | 0 | 0 |

No full profile reported missing PostgreSQL or S3 services. The final profile ran
all 133 suites without skips. Workspace typecheck, lint and build passed. Both
`.github/ci/verify-recovery-metrics.mjs` and `verify-application-recovery.mjs`
accepted all three generated profiles. Their `gitHead` is the baseline commit;
the accompanying working-tree source hashes and patch identify these uncommitted
changes. A commit hash alone would not identify the tested implementation.

The native test cluster had zero generated test databases left after the suites.
Its exact data-directory service and the verified owned Moto PID were stopped;
local logs/data files were retained. Existing services were left alone.

The unchanged Dockerfile built `telesphoros-t02:verification` for `linux/amd64`,
running as `10001:10001`. Image ID:
`sha256:fc0a00e3268665f99391e6f8ea58d67a7df0a24b57e33f45b76c76216c9fee4c`.
The existing `infrastructure/docker/rehearsal.cjs` passed provisioning, pristine
startup refusal, migration execution, privilege verification, two read-only
production-mode API instances (health/readiness 200, unauthenticated 401),
cross-process containment with a healthy-tenant control, and contained readiness
on both instances. This was a local synthetic PostgreSQL/Moto rehearsal, not AWS
or deployment verification. The harness removed its generated containers and
network; a subsequent inventory found zero rehearsal containers/networks and no
listeners on the two native test ports. The built local image is retained.

Reproduction commands (set the two test service endpoints privately to fresh,
owned disposable services first):

```sh
pnpm --filter @telesphoros/backend test --runInBand --runTestsByPath test/db/migrations.pg-spec.ts test/db/readiness.pg-spec.ts test/health.e2e-spec.ts src/health/readiness.service.spec.ts
pnpm --filter @telesphoros/backend test
TEST_STORAGE=postgres pnpm --filter @telesphoros/backend test
TEST_STORAGE=postgres TEST_OBJECT_STORAGE=s3 pnpm --filter @telesphoros/backend test
pnpm typecheck
pnpm lint
pnpm build
node .github/ci/verify-recovery-metrics.mjs
node .github/ci/verify-application-recovery.mjs
node --test infrastructure/docker/guard.test.mjs
docker buildx build --platform linux/amd64 --load -f infrastructure/docker/api.Dockerfile -t telesphoros-t02:verification .
node infrastructure/docker/rehearsal.cjs telesphoros-t02:verification
```

Run the full profiles sequentially, without overlapping workspace builds. The
first profile assumes `TEST_STORAGE` and `TEST_OBJECT_STORAGE` are unset; each
profile requires both `TEST_DATABASE_URL` and `TEST_S3_ENDPOINT` to include all
service-backed suites. Include PostgreSQL 16 client tools in `PATH` for recovery
tests. Do not interpret a successful service-free Jest run as equivalent evidence.

## Follow-ups

Only the T02 readiness defect is addressed. The package's broader old/new schema
compatibility manifest, unexplained historical T05 ledger-watch finding, G01,
hosted acceptance and clinical release remain separate. Commit and draft PR
delivery are authorized; merge and deployment are not. This local receipt does
not claim remote CI success or close any broader gate.
