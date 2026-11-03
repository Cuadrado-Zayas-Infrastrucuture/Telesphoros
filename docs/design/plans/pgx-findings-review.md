# Independent findings review and source-conflict resolution (032 S2c)

Date: 2026-11-03
Status: Authorized by the founder's continuation brief and plan approval (2026-11-03). Build from merged main (39713db5); synthetic data only.

## Complete path

In the existing owned-local report panel a reviewer, who neither uploaded nor saved the evidence, checks each stored finding against its source and records one decision per finding. When one laboratory revision has conflicting stored sources, a reviewer records an explicit decision about the whole set. The panel shows each finding with its coverage, analytical and interpretation state, the latest decision, and the outstanding actions.

Migration 0069 adds two append-only, ledger-covered tables. The ledger event types are `structured-finding-review` and `structured-source-resolution`.

| Record | What it says | Never says |
| --- | --- | --- |
| `structured_finding_reviews` | One finding of one immutable revision `accepted-as-evidence` (reason `matches-source`), `rejected` (`does-not-match-source`, `source-unreadable`) or `held` (`needs-clarification`, `source-uncertain`). A newer row for the same finding supersedes the older; both stay. | That the finding is interpretable, actionable or approved. The finding's own analytical and interpretation state are unchanged and still displayed. |
| `structured_source_resolutions` | For one patient, laboratory, series and revision number, the exact sorted set of conflicting revisions the reviewer saw, and `use-revision` (one named revision), `none-usable` or `keep-held`, with a coded reason. | That a source is deleted, merged or corrected. A source not chosen stays stored and is shown as not selected. |

## Contract decisions (from the repository)

- **Independence follows the patient-link rule** (`report_patient_decisions_check`): the reviewer is not the report's creator, upload requester or uploader, and also not the person who saved the revision. Role is `reviewer`; membership is current at commit. Refusals are 409 with a plain reason.
- **Patient matching stays separate.** Findings review reads the verified patient-link decision and binds to it by id, source hash and object version. It never writes or changes a link decision.
- **Freshness is checked at commit.** The writer takes the same two advisory locks as the revision save, re-reads one SQL snapshot of the patient's complete stored set, re-runs lineage, and requires the revision to be a current candidate. A deferred database trigger repeats the source, patient, link, role and independence checks at COMMIT, and refuses a revision with a later revision in its series or an unresolved conflict not resolved in its favour.
- **Conflicts are never resolved silently.** A same-revision conflict is the existing `duplicate-revision-content` hold. Nothing selects a source on its own. A resolution is stale when the set of sources for that revision changes, and the conflict reopens. The chosen source must be in the exact set and no later revision may exist, so a superseded revision is never revived. Other holds (gaps, predecessor, identity) are not resolvable here and show "wait for a new source".
- **Idempotency.** Each write carries a client request id. Replay returns 200 with the current state, and a changed body under the same id is refused. A lost reply clears local state and requires a fresh read.

## Review states

Per record: `not-reviewable` (not recorded, held, superseded or not selected), `awaiting-review`, `in-progress`, `attention` (some finding on hold), `complete` (every finding accepted or rejected). Outstanding actions: `review-findings`, `reopen-held-findings`, `resolve-source-conflict`, `await-new-source`, `recheck-changed-binding`.

## Boundaries

No interpretation, CPIC content, vendor-PDF reader, prescribing logic, assessment generation, clinical release, secondary-use export or deployment. Accepting a finding as evidence leaves ambiguous and indeterminate findings exactly as stored. Existing clinical, data-rights and real-data gates stay closed. Writer and verifier rollout must be coordinated before the new event types are used; the down migration refuses populated records.

## Verification

Acceptance written first (all failed at missing routes), then implementation. See the [status fragment](../../status/2026-11-03-pgx-findings-review.md) for measured results and limits, and [acceptance](../../../specs/032-pgx-report-service/acceptance.md) for the boundary this evidence covers.
