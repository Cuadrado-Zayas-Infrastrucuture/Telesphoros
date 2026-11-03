# Stored synthetic report findings and revision history — 032 S2b2

Date: 2026-11-02

## Implemented

The existing owned-local report panel can save laboratory findings after an independent patient-link decision. The server re-reads the pinned object version, checks its SHA-256 and strict synthetic package, and derives the stored evidence itself. The client sends only the expected patient/source/reference/review binding. An immutable revision and its ledger event commit together; retries and concurrent saves return the same identity. Separate uploads retain separate provenance even when their bytes match.

Migration 0068 adds ledger-covered laboratory revisions and a read-only, security-invoker finding view. Stable revision/finding references expose coverage, analytical/interpretation state, original calls, uncertainty, assay metadata and limitations without a second mutable copy. Tenant RLS and append-only guards apply; the down migration refuses populated evidence under the real non-superuser migrator. Existing ledger projections are unchanged. Writer/verifier rollout must be coordinated before using the new record type.

Reconciliation inspects the complete bounded patient history, with explicit holds for conflicting revisions, missing predecessors and changed source/review bindings. It refuses issuer identities already associated with another patient. A complete eligible chain selects only its latest source as a candidate for independent findings review; it never fills absent findings from older reports. The UI shows saved/held/superseded status and a compact history disclosure. A completed matching form collapses. An uncertain save response clears local state and requires a fresh read before retrying.

See the [bounded plan](../design/plans/pgx-stored-revisions.md) and [updated acceptance boundaries](../../specs/032-pgx-report-service/acceptance.md).

## Verification

The first three API acceptance tests failed at the missing routes (404). The completed real PostgreSQL/S3 suite passes 22 cases covering storage/view/ledger, idempotency, concurrent saves, distinct duplicate provenance, conflicting/orphan/complete amendment chains, cross-patient issuer identities, stale review/patient/source bindings, deleted and merged patients, missing pinned bytes, revoked authors, complete-history limits, RLS, append-only constraints, atomic commit refusal and corruption detection. The down-guard suite verifies refusal behind FORCE RLS and empty down/up reversal as the non-superuser migrator. The exhaustive key/constraint/index, append-only class, policy and rollback inventories include the new table; their focused catalogue suites pass 115 cases. The existing patient-decision truncate test now uses CASCADE to reach the same append-only trigger past the new foreign-key refusal, retaining its expected error.

Two temporary guard-removal controls failed for the intended unsafe behavior: disabling cross-patient identity refusal made all three collision cases return 201 instead of 409; removing the deferred current-review trigger allowed a stale transaction to commit. The intact migration was restored and the complete 22-case suite passed. The initial full memory profile exposed a missing PostgreSQL tool locator and the new table’s missing catalogue entries; the setup and inventories were corrected, preserving every assertion, and the complete profile passed on a fresh run. Test fixtures and browser runs use only invented genes/calls; no real reports or guideline recommendations were loaded.

The browser flow passes at 375×812 and 1280×800 through chat upload → patient creation/selection → independent patient matching → save → expanded history → reopen. Actual PostgreSQL application-role/S3-compatible storage and the synthetic identity provider are used; Moto does not establish AWS IAM acceptance. Controls remain at least 44px; reflow and axe checks pass in expanded review and saved-history states. Both screenshots were manually inspected. The saved-history interface also has seven component cases covering the exact write body, verified-link requirement, ambiguous replies, holds, response binding and aborted late reads. Those component tests mock API replies to exercise UI states; the integration and browser tiers exercise actual storage.

Local workspace checks have passed typecheck, lint/format, test, build, 285 infrastructure guards, 217 CI-configuration guards and frontend chunk/production-exclusion checks. Shared contracts: 245 passed. Frontend: 711 passed plus 55 brand/deployment guards. Worker: 151 passed. Default backend: 2,082 passed / 504 skipped before the final additional merged-patient case; those default service skips are not database acceptance.

All three complete backend profiles passed with the disposable PostgreSQL/S3 services available: memory 3,414 passed / 705 skipped (259 passing suites); PostgreSQL 4,063 passed / 56 skipped (290 passing suites); PostgreSQL/S3 4,117 passed / 2 skipped (293 passing suites). Skips are reported rather than counted as acceptance. Both existing F2 independent-recovery and F3 application-recovery validators passed for all three fresh profile artifacts at the tested checkout. These are loopback PostgreSQL/Moto recovery rehearsals, not hosted disaster-recovery approval.

## Limits and follow-ups

This is owned-local synthetic evidence capture, not clinical analytical acceptance, issuer authentication, a reconciled cross-laboratory patient profile, assessment generation, CPIC interpretation, vendor-PDF extraction, secondary-use export or deployment. Existing clinical/data-use gates remain closed. Five absent-reader-engine specifications remain explicitly excluded. Full ordinary/DEV browser suites and image/runtime release rehearsal were not run locally. Node 22.22.0 and pnpm 10.28.0; main base `25062cfa`. Local checks are not hosted exact-commit CI or clinical approval.

Next: independent findings acceptance and source-conflict resolution, then context-bound synthetic assessments and affected-assessment review tasks. Preserve this source → finding → assessment → physician decision → follow-up chain for future authorized Data Insights work.
