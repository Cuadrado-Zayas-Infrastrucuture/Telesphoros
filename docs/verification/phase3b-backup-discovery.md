# Phase 3B verification

2026-10-10; baseline main `629805a`; Node 22.22.0, disposable PostgreSQL 16.14 with SCRAM authentication and local Moto S3. Synthetic data only, no live provider or production database.

## Defect and result

The original loop returned accumulated names after 1,000 pages even when more results remained. A missing continuation token could repeatedly request the first page before falling through the same cap. That partial window could yield a stale complete backup. Remote recovery also suppressed every discovery exception into an indistinguishable “no complete backup” report.

`IncompleteBackupListingError` extends the existing safe-message `OffsiteError`. Truncated pages without a usable next token fail immediately. A still-truncated 1,000th page fails after exactly 1,000 requests; a terminal page at that boundary succeeds. The error propagates through latest selection and remote recovery; no manifest lookup, download folder or restore engine call occurs. Ordinary provider refusals retain their existing failed report. The freshness monitor's existing catch reports the typed failure and cannot produce authentic/recent backup claims.

The pagination contract is based on [AWS ListObjectsV2](https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListObjectsV2.html): a truncated response has more results, and its next continuation token advances the listing. Sorting backup timestamp names happens only after exhaustion. This does not promise a snapshot across concurrent uploads or completeness against a provider that lies about its truncation flag.

## Controls and local verification

| Evidence | Result |
| --- | --- |
| Original implementation, incomplete-listing controls | 12 failed / 4 passed; missing/null/empty token and cap defects reproduced through listing, latest selection and recovery |
| Final boundary suite | 20 passed; four additional freshness-monitor controls; opaque tokens, empty truncated page, empty complete result, terminal page 1,000 and ordinary AccessDenied controls |
| Real PostgreSQL/S3 regressions | Four suites, 74 tests passed in 22.161 s before the four monitor-only cases were added; no skips |
| Emulator pagination | SDK requests use MaxKeys=1, forward real opaque provider tokens and include all backup prefixes; newest incomplete upload skipped only after full listing |
| Built CLI, local HTTP fault provider | Missing/empty XML token: exit 1 after one listing; still-truncated cap: exit 1 after 1,000 listings; no object reads, database connections or temp files, including with --keep |
| Built CLI, empty complete prefix | Existing explicit no-complete-backup failure retained; no recovery side effects |
| Backend lint, typecheck, build | Passed |
| Complete default backend tier with SCRAM PostgreSQL/S3 available and CI=true | 105 suites / 1,531 tests passed in 113.102 s; seven suites / 182 profile skips; no missing-service or trust-auth skips |

Initial CLI probing used an `xsi:nil` XML token unsupported by the SDK's S3 string decoder; it produced an ordinary listing failure before the application guard. It is not counted as typed-error evidence. Runtime null is tested at the SDK-result boundary, while CLI probes use missing/empty XML strings.

Final-head CI outcomes are recorded in the PR. Required acceptance includes inspected database job logs with zero failed tests, not only green check statuses. Profile-specific skips must be distinguished from missing-service skips. No RTO or GB-scale restore claim is made by these small regression fixtures; the size/timing rehearsal is Phase 3C.

## Remaining limits

The 1,000-page safety cap deliberately refuses oversized discoveries rather than choosing a partial result. Investigate listing/provider behavior or use a specifically named, independently verified backup; do not treat that manual choice as proof of newest status. No new retry or scheduling policy, live-provider validation, immutable report-file copy, deployment or clinical release is included.
