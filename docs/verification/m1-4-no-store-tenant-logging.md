# M1.4 no-store responses and tenant-correlated logs: verification

Implementation on `claude/m1-4-no-store-tenant-logging`, based on main `bdb1935`. Scope and decisions are in the [slice plan](../design/plans/m1-4-no-store-tenant-logging.md). Results below were captured locally before committing; the required CI checks are reported separately on the PR head. Synthetic data only; nothing was applied in AWS.

## What was implemented

| Change | File |
| --- | --- |
| `noStoreMiddleware` sets `Cache-Control: private, no-store`, registered right after the request-id middleware | `apps/backend/src/common/no-store.middleware.ts`, `apps/backend/src/app.factory.ts` |
| `tenantId` added to the request-completion log, from the verified principal | `apps/backend/src/logger-options.ts` |
| `tenantId` added to the `Request rejected` and `Request failed` log lines | `apps/backend/src/common/all-exceptions.filter.ts` |
| Authenticated browser requests send `cache: 'no-store'`, after the caller's options | `apps/frontend/src/auth/AuthProvider.tsx` |

No SQL, grant, dependency, Terraform or authorization code changed.

## Tests added

| Test | What it proves |
| --- | --- |
| `test/no-store.e2e-spec.ts` (5 tests) | `private, no-store` on authenticated 200 reads, a 201 create, 400 validation and malformed-JSON errors, 401 (missing and invalid token), 403, 404 (record and route), the public health and readiness probes, and a 429 with `Retry-After` |
| `test/api-log-tenant.e2e-spec.ts` (3 tests) | Real `AuthGuard`, exception filter and pino-http options over real HTTP: the completion log and the failure log carry `tenantId` and `userId` for an authenticated request; unauthenticated requests (including a spoofed `X-Tenant-Id` header) carry no `tenantId` anywhere in the output |
| `apps/frontend/src/auth/AuthProvider.test.tsx` (1 test) | The wrapper sends `cache: 'no-store'` on every call, even when a caller passes `force-cache` |

## Failure before the change, success after

Run on the unchanged source (tests only, no production change):

| Run | Result |
| --- | --- |
| `no-store.e2e-spec.ts` + `api-log-tenant.e2e-spec.ts`, first run | 8 failed, 0 passed (the header was `undefined` everywhere; the tenant was missing from the logs). One failure was a defect in my own test (a query string, which the input boundary rejects with 400); fixed and re-run |
| Same files after fixing that test | tenant-presence tests fail (2), the "unauthenticated" control passes (1), all 5 header tests fail |
| `AuthProvider.test.tsx` | 1 failed (`[undefined, undefined, 'force-cache']`), 13 passed |

After the change: the 8 backend tests and the frontend suite (14) pass.

Defect injection: temporarily reading the tenant from `X-Tenant-Id` when no principal exists made the spoofing control fail (1 failed, 2 passed). The file was restored (`git diff` shows only the intended three added lines) and the file passed again.

## Full local regression

Node 22.22.0, pnpm 10.28.0, frozen lockfile. PostgreSQL 16 on a loopback trust-authentication dev cluster (port 54329) and Moto 5.2.3 on port 5555 in an isolated virtual environment.

| Check | Result |
| --- | --- |
| `pnpm typecheck`, `pnpm lint`, `pnpm build` | passed |
| `pnpm test:ci-config`, `pnpm test:infra` | passed (35 and 31, 0 failed) |
| Tier 1 (`pnpm test`) | backend 1,236 passed, 201 announced service-dependent skips (up 11 from 1,225); frontend 223 passed (up 1); SMART pilot 186; CPIC schema 36; shared types 22; fake IDP 7; Lambda notifier 9; orchestration and storage-ops 22 |
| Tier 2 (PostgreSQL) | 1,818 passed, 77 skips (S3-only and password-check suites on a trust cluster), 0 failed |
| Tier 3 (PostgreSQL + Moto) | 1,904 passed, 0 skips in the main run; 37 failed |

**The 37 tier 3 failures are an environment limit, not a regression.** Every one was `Recovery rehearsal must run as an unprivileged OS user.` (74 occurrences across the three recovery specs), because this sandbox runs as root. After creating an unprivileged OS user and running those three specs from a writable copy of the repository, they passed: **3 suites, 37 tests, 0 failed.** Tier 3 is therefore 1,904 + 37 = 1,941 passed, 0 failed, 0 skipped. The copy and the user were removed afterwards.

## Limits

- The browser (Playwright) tier was not run locally; CI runs it. No browser test asserts cache behavior; the header is verified at the HTTP layer.
- Real-browser back-navigation and CDN behavior need a hosted deployment and stay in T13 hosted acceptance. Nothing here claims they are proven.
- `Cache-Control` on a response does not recall data a browser or proxy already stored before this change. It governs new responses.
- The security-event audit store and sensitive read/export events (M1.6) are not part of this slice.
- `tenantId` is an organization identifier; if it should not appear in diagnostics, the field can be dropped or hashed in `logger-options.ts` and the filter without other changes.
