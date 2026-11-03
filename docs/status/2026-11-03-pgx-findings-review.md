# Independent findings review and source resolution — 032 S2c

Date: 2026-11-03

## Implemented

The existing owned-local report panel now shows each saved synthetic finding with its coverage, analytical and interpretation state, and the latest independent decision, with the outstanding actions. A reviewer who neither uploaded nor saved the evidence records `accepted-as-evidence`, `rejected` or `held` per finding. A decision records only whether the stored finding matches its source; ambiguous or indeterminate findings stay exactly as stored and nothing becomes actionable. Patient matching is a separate record and is never written here.

Migration 0069 adds append-only, ledger-covered `structured_finding_reviews` and `structured_source_resolutions` (tenant RLS, mutation and truncate guards, deferred commit-time recheck of source, patient link, reviewer role and independence). When one laboratory revision has conflicting stored sources, a reviewer chooses one source, records that none is usable, or keeps the hold, naming the exact set seen. No source is deleted, merged or silently chosen; a source not chosen stays in history as not selected and is never revived. A resolution goes stale when another source arrives. The down migration refuses populated records. Writer and verifier rollout must be coordinated before the new event types are used.

See the [bounded plan](../design/plans/pgx-findings-review.md) and the [updated acceptance boundary](../../specs/032-pgx-report-service/acceptance.md).

## Verification

RESULTS PENDING.

## Limits and follow-ups

This is owned-local synthetic evidence review, not analytical acceptance, issuer authentication, an assessment, a reconciled patient profile, CPIC interpretation, vendor-PDF extraction, secondary-use export or deployment. Existing clinical and data-use gates stay closed. Next: context-bound synthetic assessments and review tasks triggered by changed evidence, preserving source → finding → assessment → physician decision → follow-up links.
