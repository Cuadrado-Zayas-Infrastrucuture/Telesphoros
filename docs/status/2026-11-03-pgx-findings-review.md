# Independent findings review and source resolution — 032 S2c

Date: 2026-11-03

## Implemented

The existing owned-local report panel now shows each saved synthetic finding with its coverage, analytical and interpretation state, and the latest independent decision, with the outstanding actions. A reviewer who neither uploaded nor saved the evidence records `accepted-as-evidence`, `rejected` or `held` per finding. A decision records only whether the stored finding matches its source; ambiguous or indeterminate findings stay exactly as stored and nothing becomes actionable. Patient matching is a separate record and is never written here.

Migration 0069 adds append-only, ledger-covered `structured_finding_reviews` and `structured_source_resolutions` (tenant RLS, mutation and truncate guards, deferred commit-time recheck of source, patient link, reviewer role and independence). When one laboratory revision has conflicting stored sources, a reviewer chooses one source, records that none is usable, or keeps the hold, naming the exact set seen. No source is deleted, merged or silently chosen; a source not chosen stays in history as not selected and is never revived. A resolution goes stale when another source arrives. The down migration refuses populated records. Writer and verifier rollout must be coordinated before the new event types are used.

See the [bounded plan](../design/plans/pgx-findings-review.md) and the [updated acceptance boundary](../../specs/032-pgx-report-service/acceptance.md).

## Verification

The new API acceptance file was written first and failed at the missing routes (404) and tables. After implementation its 17 real PostgreSQL/S3 cases pass: exact binding, replay and changed-body refusal, newest-decision-wins history, uncertainty unchanged by acceptance, no patient-link write, saver/uploader refused through the API and by direct SQL, role/tenant/strict-body refusals, held/superseded/not-selected revisions closed to review, conflict resolution (use one, none usable, keep held) that keeps every source and goes stale when a source arrives, non-conflicts and unknown sets refused, commit-time recheck with rollback of row and ledger event, revoked reviewer, append-only and ledger-verifier corruption. Two guard-removal controls (independence check, deferred commit-time recheck) each failed the suite; the migration was restored (same hash). The down-guard suite covers refusal when populated (behind FORCE RLS) and reversal of the empty migration. Existing schema, tenant-policy-count (84) and ledger inventories were extended without weakening assertions.

Browser (real PostgreSQL application role, Moto, synthetic identity provider): chat upload, patient creation, independent patient link, save, then a third person reviews the finding, at 375 and 1280 wide. Axe, no horizontal overflow and 44 px controls pass; the uncertainty text stays after acceptance and no interpretation or prescribing control appears. Conflict resolution has component (13) and API cases but no browser flow.

Local results at `cab21e2e` (Node 22.22.0, pnpm 10.28.0, PostgreSQL 16.15, Moto, owned loopback services): memory profile 3,417 passed / 722 skipped (259 passing suites); PostgreSQL 4,066 passed / 73 skipped (290); PostgreSQL/S3 4,137 passed / 2 skipped (294). Five engine-absent specifications remain skipped and are missing evidence, not passes. Both recovery validators passed for all three profile artifacts at that commit. Shared contracts 246, frontend 725 plus 55 guards, worker 219 passed / 2 skipped. Typecheck, lint and build passed. After merging main (#268, #269: CI and release files only, none of this change's files) CI-configuration guards 220, infrastructure guards 300 and lint passed again. gitleaks 8.30.1 found no leaks in the new commit. A first PostgreSQL run overlapped a sleeping laptop and timed out across unrelated suites; it is not counted, and the complete reruns above were made under `caffeinate`. Hosted exact-commit CI, the full ordinary and DEV browser suites, the image rehearsal and AWS IAM behavior were not run locally.

## Limits and follow-ups

This is owned-local synthetic evidence review, not analytical acceptance, issuer authentication, an assessment, a reconciled patient profile, CPIC interpretation, vendor-PDF extraction, secondary-use export or deployment. Existing clinical and data-use gates stay closed. Next: context-bound synthetic assessments and review tasks triggered by changed evidence, preserving source → finding → assessment → physician decision → follow-up links.
