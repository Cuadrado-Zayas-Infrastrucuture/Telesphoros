# F06 verification — publication candidate and historical integration

## Fresh publication candidate — 2026-10-16

Branch `fix/f06-upload-recovery-publication` is freshly based on fetched main `75bdc20`, carrying runtime `0a45405`, races `fe4251b`, and test-only `86fb1ca`. All **19 promoted probes** are permanent: six delayed-body/stale-404 page/session races, one stale-role-body race, three recovered-state downloads, four download refusals preserving newer recovery, four retirement-before-download races, and one memory-only reconciliation/download. The 12 unit probes use the existing download implementation; they do not depend on F07's policy changes.

The fresh verification plan covers five focused frontend suites; full frontend, branding/preview and shared tests; workspace build/typecheck/lint; controller and memory/real-PostgreSQL-S3 authority/upload tests; default and enabled built-browser auth/upload/reload/navigation; and all four old/new UI/API combinations, including a genuine old-API capability 404. The F07 real-storage browser bridge and policy/launcher checks remain in the later intention. Fresh execution results, final candidate hash, exact commands/exits and preservation/cleanup proof belong to the external `f06-publication-local-verification` receipt. The historical counts below are not claims about this candidate. No remote CI, hosted or clinical acceptance is claimed.

Both source integration branches and combined `86fb1ca` remain preserved. No dependencies, CORS/infrastructure, schema, roles, retention or clinical behavior change is included.

## Historical integration evidence — 2026-10-15

Local branch: `fix/f06-recovery-integration`. Reviewed source: `cf10828`. Initial baseline: `b272c75`; refreshed baseline: `75bdc20` after #129 merged. Existing F06 and both F07 branches remain untouched. No push, PR, deployment, live provider or clinical acceptance.

## Behavior and integration

`GET /me` remains exactly roles-only. The separate authenticated `/me/recovery-scope` correlates verified caller/tenant without granting authority. Only a genuine capability 404 permits memory-only fallback; other capability failures refuse sign-in without redirect loops. V2 metadata has the original one-hour deadline across retry/reload/reauthentication. Foreign, legacy, malformed, future and expired hints are removed before display. Metadata expiration does not cancel/delete server state.

Merged #111 page retirement is retained and extended with the F06 session check in the existing upload guard. Request boundaries, delayed body consumers and metadata changes require both lifetimes. Ten pending-body cases independently retire page/session during registration, state, declaration, bytes and cancellation. Current main's sidebar, guided upload, styling and clinician handoff are preserved. No schema, roles, server attempt lifetime, retention, dependencies, CORS or infrastructure changes.

## Verified source and test results

| Check | Result |
| --- | --- |
| Unchanged-main regressions | Ownership and one-hour expiry assertions both failed as expected before integration. |
| Refreshed frontend | 337 tests passed; 36 Node branding/preview controls passed. |
| Shared contracts | 32 passed. |
| Full backend: memory API plus real PostgreSQL/S3 specs | 150 suites passed; 2,052 tests passed; 253 profile-dependent cases skipped. |
| Full backend: PostgreSQL API | 159 suites passed; 2,284 tests passed; 21 profile-dependent cases skipped. |
| Full backend: PostgreSQL + S3 API | 161 suites passed; 2,304 tests passed; one memory-only fallback case skipped. |
| Worker on PostgreSQL/S3 | 13 files / 123 tests passed. |
| Build/typecheck/lint/chunks | Passed after the #129 refresh. Both build branding gates retained; 79-component foundation check passed. |
| Guards | 66 infrastructure, 39 CI, 21 image-text, 8 workspace and 16 operations controls passed. Image text checks are not a container build or hosted proof. |
| Independent scratch defects | Ownership, expiry, session retirement and page retirement each produced assertion failures. Source and controls remained byte-identical across the main refresh. |
| Test isolation | The idle-expiry case failed when run alone due to scoped fixture setup; moving session ownership setup to a per-test root hook made the isolated case and full suite pass. No runtime rule was changed. |

Backend and shared source are byte-identical across the #129 refresh. The full-profile results above therefore remain applicable; refreshed frontend/build/browser checks were repeated. Native recovery receipts are separately checked on the final local Git HEAD: both unchanged validators must pass all three producer profiles. Exact producer heads and final validator outputs are retained in the external task receipt; earlier mixed-head receipts remain historical evidence, not exact-head proof. No receipt fields or validator rules were rewritten.

## Compiled client/API compatibility

| Compiled client | API | Desktop/mobile case executions |
| --- | --- | ---: |
| Cached unchanged `b272c75` | Unchanged `b272c75` | 50 passed |
| Cached unchanged `b272c75` | Integrated | 50 passed |
| Refreshed integrated frontend | Actual unchanged API, capability 404 | 28 passed |
| Refreshed integrated frontend | Integrated | 60 passed, plus 8 guided-upload/role cases |

196 case executions across four combinations, not 196 distinct scenarios. The old-backend fallback uses its real 404 without interception. All 1,299 tracked baseline files matched their Git objects. Cached compiled asset hashes matched before/after; copied baseline test files were byte-identical and used one Playwright installation. Old client code remains old until refreshed; compatibility cannot retrofit the new privacy/session guards into cached JavaScript.

## Harness corrections and controls

Only fresh loopback PostgreSQL 16 and pinned Moto 5.2.4 were used, with Node 22.22.0 and durability defaults retained. Inherited AWS variables were stripped; null config paths and explicit synthetic credentials were used. Application-role password checks use SCRAM, not trust authentication. The initial trust setup was correctly rejected by provisioning controls (`CI must run this suite on a cluster that checks passwords (got: connected)`); the corrected 20-test provisioning suite passed before restarting all full profiles.

Other corrected harness failures: sandbox process/network restrictions; occupied default browser port 4010 (left untouched, private ports used instead); duplicate Playwright installations across source archives; scope responses missing from two newer UI test fixtures; and generated nonstandard build assets being included by ESLint. Assets were moved outside source rather than changing lint rules. All failed attempts remain in task logs and are excluded from pass counts. The mid-run main refresh changed Git HEAD while native receipts were produced; only the affected receipt-producing suites were rerun after freezing the local commit.

Final controls include protected worktree/ref comparison, source/asset hashes, redacted secret scan, whitespace and relative-link validation. Temporary services are stopped only by their recorded task ownership; data directories and evidence are retained. External receipts record actual cleanup and final commit identity.

## Limits and follow-ups

Real Cognito/RDS/S3/CDN, hosted cache refresh, clinical acceptance and remote required CI are not established by these local checks. A container-engine image build was not run. No release gate is closed. F07 remains a separate intention. Publishing a PR or deploying requires a separate request.
