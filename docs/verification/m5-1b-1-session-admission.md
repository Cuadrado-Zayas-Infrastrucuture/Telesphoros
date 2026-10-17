# M5.1b-1 internal session admission — local verification

Local branch `feat/m51b-session-admission` starts from fetched main `1da75b1b5ff55cceb195136dbcb2ebbd805235a0`. Founder approved only the first internal admission slice. Cookie authentication remains disabled. See the [design](../design/plans/m5-1b-1-session-admission.md).

## Implemented and controlled

Three production files add a frozen, whitelisted non-secret session binding, a materialized tenant/subject/immutable-metadata session recheck, and integration after membership on the protected transaction's own PoolClient. Membership and session shared locks stay held through commit/rollback. Expiry uses database time after waits. Changed membership stays 403 with its existing refusal record; refused session is 401, unavailable session infrastructure/lock/pool is 503. No raw credential, cookie or key enters context/errors/logs.

No migration, ACL, provider registration, route, cookie, frontend, runtime setting/key, dependency, Actions or Terraform main/backend wiring change. Existing bearer and organization-owned cleanup behavior remains. A stored object after revocation cannot become a protected report pin; unresolved recovery state is retained. Tests bind synthetic authority after the real bearer guard; no product cookie path is enabled.

## Permanent cases and regression controls

- New unit **25**: bounded/canonical metadata; present malformed/undefined binding refusal; immutable owned copies with extra secrets discarded; inherited binding handling; async isolation; missing context; organization callback scope; sanitized query outage/deadlock/timeout.
- New real PostgreSQL/HTTP **28**: current write; revoked snapshot and mid-work whole rollback; writer-first commit/rollback with database-confirmed waits; expiry after session and membership waits; revoker commit/rollback; subject/tenant/handle/timestamp mismatches; accepted clock skew; changed membership/refusal recording; bearer/read/organization behavior; lock timeout/retry; pool failure/reuse; mixed lock order; real intake before/after storage, cleanup/version pinning and cookie-only 401.
- Existing session **70** are unchanged and all pass in every profile: crypto 17, custody 16, PostgreSQL 21, clock probes 16. New 53 + existing 70 = **123 session cases per profile**, all without skips. Existing membership 34, live catalog 19 and role/order 34 pass as well.
- Focused **210/210**, no failures or skipped cases. The unchanged-code reproducer demonstrated a revoked-snapshot write committing while its active control passed (`baseline-session-revoked-03`). Both new test files are permanent.
- Three controlled defects in separate disposable copies each fail their intended refusal while the positive control still passes: omitted final admission, omitted subject match, expiry moved before the lock. Each unmodified run passes both selected cases. Other cases excluded by test-name selection are not skipped selected acceptance. Copies were restored; task source was never weakened.

## Fresh complete verification

| Backend profile | Passed | Expected profile skips | Total |
| --- | ---: | ---: | ---: |
| tier1 | 2209 | 253 | 2462 |
| tier2 | 2441 | 21 | 2462 |
| tier3 | 2461 | 1 | 2462 |

All profiles used task-owned PostgreSQL 16/SCRAM and Moto. No missing-service notice occurred. The default application profile still executed the real PostgreSQL/S3 spec directories. Exclusions above are existing mode-specific cases; none of the 123 session cases skipped.

Worker **123 tests across 13 files** passed. Existing F2 independent-recovery and F3 application-recovery validators passed for all three profiles; all six aggregate artifacts are retained. Workspace typecheck, lint and build passed. Runtime: Node 22.22.0, pnpm 10.28.0, PostgreSQL 16 tools.

## Preserved recovery and origin evidence

- Frontend **142/142** includes all **19 F06** promoted case names, independently matched to the retained inventory. The original one-hour recovery deadline, caller/tenant binding, independent page/session retirement, exact roles-only `/me` and separate recovery capability remain unchanged.
- F07 local **30** CORS checks pass, including all **25** promoted local probes; all **13** promoted native Terraform origin cases pass within **33** offline mocked plans. All **five** launcher checks pass, including older review launcher GET parity. Terraform init used backend=false and an owned data directory; no AWS plan/apply or wiring change.
- Browser **97 successful executions**: default auth 26, enabled F06 recovery/navigation 34, real PostgreSQL/S3 storage/download 33, cached old-UI/new-API 2 and current-UI/actual-old-API 2. Desktop/mobile bridge coverage preserves registration/declaration/attempt/original timestamp through reload/reauthentication, downloads exact pinned bytes/version/hash, refuses direct storage PUT and credential/referrer leakage, and checks storage identity after download. Version-pin acceptance ran last through existing project dependencies.
- Genuine capability 404 uses the actual route-absent old backend and its own provisioned legacy-schema database, without fulfilling that response. The existing intercepted-404 spec is also retained; it does not substitute for the real legacy journey. Old source **1,311 files** and retained server/bundle **409 files** hash-match their prior receipt, and were not edited/rebuilt.
- All **57 promoted probes** (19 F06 + 38 F07) and the additional browser bridge remain byte-identical to main. The bridge is additional coverage, not a 58th promoted probe.

## Repairs and evidence limits

Initial harness failures were retained and corrected: wrong Jest config extension; reused then overlong synthetic labels; application role correctly refusing a membership-row lock fixture; missing dependency links in mutation copies/the Lambda workspace; and running a default-mode Reports-unavailable assertion against the owned-storage-enabled build. No product safeguard or test was weakened/deleted. The first mixed browser run's 58 successes/two mode-mismatch failures remain historical; 97 refers to the corrected selections and compatibility runs.

The application/package source stayed fixed through full profile execution (`tested-code-hashes.json`, 808 files). Native recovery receipts name the working-tree starting HEAD `1da75b1`; source hashes bind the tested contents to the subsequent local commit. These are not new exact-head GitHub CI results. Main's six green checks were baseline evidence; the new local commit has no remote CI. No hosted Cognito/key custody/CloudFront, container-runtime or clinical acceptance is claimed.

M5.1b-2 login transactions/exchange and b-3 cookie/CSRF/generation/configuration/endpoints remain open. Future logout needs an explicitly authorized terminal transition in consistent lock order; ordinary session-bound admission is not a blanket bypass. Read-time guards and frontend/same-origin integration remain later work. This slice alone is not completed M5.1b or M5.1.

Full native stdout/stderr, exits, exact case/probe inventories, mutation controls, legacy compiled binding and source/protected hashes are retained outside this checkout in the task's `work/m51b1-verification/`. Credentials are private and never printed. Only owned loopback services were stopped, retaining data/logs. No protected source checkout, Actions/main wiring, push, PR, merge, live migration, cloud resource or deployment command is changed/run.

## Permanent review probes (2026-10-16)

The 12 review-only probes from `fdc2687` are now permanent in `apps/backend/test/db/session-admission.pg-spec.ts`. Original tests remain intact. The PG spec now has 40 cases; with 25 unit cases, b-1 has 65 admission cases, plus 70 unchanged M5.1a cases = **135 session cases**. Promotion removes temporary review labels, explains connection-start isolation and independent revoker context, and strengthens the self-revocation rollback control to read the same original session cookie.

Coverage includes ordinary in-flight expiry; expired-row cleanup; final-admission expiry versus commit-held locks and cleanup; membership timeout/retry, refusal precedence and version restoration; another handle's revocation; row-locking reads; stale repeatable-read snapshots; membership locks while waiting for session; missing membership infrastructure; and refusal to bypass admission through self-revocation. No new product behavior is introduced.

Fresh focused verification on the promoted test contents:

| Application profile | Passed | Failed | Skipped | Session cases |
| --- | ---: | ---: | ---: | ---: |
| PostgreSQL | 222 | 0 | 0 | 135 |
| PostgreSQL + S3/Moto | 222 | 0 | 0 | 135 |

Both runs execute ten focused suites with fresh task-owned PostgreSQL 16/SCRAM and Moto, using restricted application roles, actual migrations/RLS and HTTP intake/storage. All 210 original focused case names and all 12 promoted names are accounted for in both results. No missing-service notice occurs. Backend typecheck and lint pass. Full native producer output/status and case/source inventories are retained in the outer workspace's `work/m51b1-probes-verification/`.

Production code, migrations, ACLs, cookie/provider/runtime wiring, Actions/main wiring, dependencies, frontend and all protected sources remain unchanged. Cookie authentication remains disabled. Full-profile/worker/browser/build/recovery acceptance above belongs to the prior build and was not rerun for this test-only promotion; focused PG/S3 runs above are fresh. The unpublished local commit has no remote exact-head CI or hosted acceptance. No push, PR or deployment is authorized.

## Local synchronization with main 34d6093 (2026-10-16)

After PR #149's e728811 run exhausted the older sequential job's 30-minute budget, the approved local update adopts main `34d6093962d3d029aa3c6a4d8ec6be9b652a0c78` through a merge that preserves published fdc2687/e728811 as ancestors. Main's PR #150 workflow, helpers and preparation scripts are inherited byte-for-byte. There are no independent Actions, deadline, required-check, permission or main-backend wiring edits. Cookie authentication remains disabled.

STATUS combined cleanly, preserving both main's CI history and the M5.1b sections. SESSION_STATE was the sole manual conflict; the current integration summary and both dated prior session records are retained. Production code, application/package tests, migrations, dependencies and preview configuration remain unchanged from e728811. All 135 session cases, 12 promoted probes, 57 F06/F07 probes and the additional browser bridge are preserved.

Fresh verification on the fixed integrated source:

| Check | Result |
| --- | --- |
| Focused PostgreSQL, 10 suites | 222 passed, zero failed/skipped; all 135 session cases |
| Focused PostgreSQL + S3/Moto, 10 suites | 222 passed, zero failed/skipped; all 135 session cases |
| Backend typecheck and lint | passed |
| Unchanged current-main CI controls | 111 passed, zero failed/skipped |
| Workspace orchestration controls | 8 passed, zero failed/skipped |
| Workflow-pack check and controls | check passed; 4 tests passed |
| actionlint and whitespace | passed |

Native accounting matches every original 210 focused case name plus all 12 promoted names in both profiles. Inheritance checks cover 145 files under `.github`, `scripts`, `docs/ops` and `infrastructure`. Node 22.22.0/pnpm 10.28.0 and fresh owned PostgreSQL 16/SCRAM and Moto were used; there was no missing-service notice. Complete native output/exits and fixed application/package hashes are retained externally in `work/pr149-local-main-sync/`. Protected checkout/ref hashes and final merge-parent, cleanup and secret-scan receipts are recorded there at completion.

These are local focused/static results. Full backend, worker, browser, build, recovery and GitHub/Linux producer/joining-gate acceptance were not rerun for this synchronization. The new evidence gate's Linux/current-run/attempt/checkout metadata must come from a fresh CI run after separately authorized publication; local macOS output is not relabeled or substituted. Earlier full-suite and cancelled-run passing test-step evidence remains historical. The local merge commit stays unpushed; PR #149's remote head remains e728811. No CI rerun, PR edit, GitHub merge, manual/backend deployment or integration-setting change was performed.
