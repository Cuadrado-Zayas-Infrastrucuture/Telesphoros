# PGx report-service specification verification

Date: 2026-11-02

Scope: documentation-only proposal in `specs/032-pgx-report-service/`, documentation map and status fragment, based on `main` `4615b9a2` (merged PR #258). AI-assisted drafting and repository/source inspection. No human clinical review has occurred in this change.

## Static review

- Read current adapter, evaluation, clinician-decision and follow-up contracts, service/repository code and adjacent acceptance tests; preserve authority, independent review, immutable evidence and current-basis checks.
- Checked local document targets, unique C01–C28 pathway IDs and A01–A19 acceptance IDs. Reviewed gene catalogue count: 21 unique genes plus rs12777823.
- Reviewed proposed fields against the research: laboratory versus derived authorship, manifest coverage, distinct uncertainty states, combined-gene rules, context changes, interim conflicts, amendments and missing-data denominators.
- Clinical statements remain candidate boundaries with primary references, not executable recommendations. No supplied personal report/document bytes or identifiers are in the diff. New scenarios are requirements, not runtime fixtures or passing clinical tests.

## Local commands

Node 22.22.0 / pnpm 10.28.0. All six required local commands exited 0. Logs retained locally under `/tmp/pgx-spec-*.log` (not committed).

| Command / scope | Result |
| --- | --- |
| `pnpm typecheck` | Passed. |
| `pnpm lint` | Passed, including source formatting. |
| `pnpm test` | Passed for configured service-free suites; skipped boundaries below are not acceptance. |
| `pnpm build` | Passed. |
| `pnpm test:infra` | 285 passed; 0 failed/skipped. Static infrastructure guards, not cloud acceptance. |
| `pnpm test:ci-config` | 217 passed; 0 failed/skipped. |
| Local documentation inspection | 10 Markdown documents, 60 local links, balanced fences; 21 unique catalogue genes plus the locus; 28 unique pathway IDs and 19 unique acceptance IDs. |
| `git diff --cached --check` | Passed. |

Workspace test counts: root scripts 47; jobs 20; password-change notifier 10; CPIC schema 48; fake IDP 7; shared types 137; AI service 347; worker 151; SMART pilot 188; frontend scripts 55 and Vitest 694; backend 2,077 passed across 156 suites. Backend additionally reports **471 skipped tests / 27 skipped suites**. Its PostgreSQL/S3 tiers were not configured and five reader-engine-dependent specs were excluded because the engine is absent. Worker PostgreSQL/S3 suites were likewise not run. No new runtime tests were added for this documentation-only change.

## Unverified boundaries

No new product behavior is implemented. The new 19 scenarios, full CPIC pair/cell reconciliation, external-vendor extraction, laboratory accuracy, clinical validation, FHIR conformance, hosted acceptance and regulatory approval are not established. No deployment or real-data processing occurred. Full PostgreSQL/S3, browser, image and hosted CI evidence are separate from documentation/static review.
