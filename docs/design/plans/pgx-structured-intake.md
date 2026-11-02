# Structured synthetic report intake and patient-link review (032 S2a)

Date: 2026-11-02
Status: Authorized by the founder's “merged, continue” after PRs #259/#260. One vertical slice from current main.

## Existing mechanisms and scope

Chat already uploads curated JSON through bounded, authenticated intake to versioned object storage and persists a patient-bound report. `PatientLinkService` already writes independent, source-version-bound patient-link decisions and their ledger events atomically, with database-enforced actor separation and commit-time authority checks. Reuse both; no parallel upload store, migration or review table is needed for this slice.

Add an explicitly owned-local-only structured-report view and patient-link action, available with PostgreSQL/S3 and `LAB_REPORT_PIPELINE=disabled`. Reuse `assertLocalStorage`, role guards and the existing membership/ledger boundary. Normal/deployed/production builds do not expose the UI; the API refuses outside the owned disposable local profile. Do not loosen any existing pipeline gate or construct the absent reader engine.

For an uploaded `structured` report, read its pinned object version, recompute SHA-256, verify type/size/version, decode strict UTF-8 and parse the bounded S1 synthetic package. Return only laboratory fields, source identity, selected application's patient label and independent patient-link state. Never treat an uploaded assessment/rule/approval flag as a Telesphoros evaluation. Unsupported or invalid JSON gets a sanitized error; its existing upload remains a stored source, not an accepted clinical record. A closing read rejects deleted/changed source or patient state; no cache or cross-patient fallback.

A separate reviewer can attest/reject the patient association using the existing coded basis and audit mechanism. Require the exact preview patient UUID, SHA-256, object version and source patient reference in the request; compare these again before committing through `PatientLinkService`. Extend that service with an optional server-supplied expected source binding so a change between preview and write cannot silently approve a newer source. Existing callers and routes retain their behavior. Acceptance of the patient link is explicitly not analytic validation, capture acceptance or a prescribing assessment.

## UI

Add a compact “Structured findings” disclosure to the report details already opened from chat/history. Show source patient reference and selected patient, laboratory/report/accession/revision, original findings and uncertainty/limitations. Show the declared amendment predecessor as unverified lineage. Reviewer-only actions require an explicit patient-match confirmation and coded reason, preserve rejected/unverified states, disable duplicate submissions and refresh after a decision. Switching reports cancels pending reads and clears old content; mutation callbacks cannot move another report's state. Preserve 44px targets and the current chat/report-panel layout.

## Verification

1. Public-contract/API refusal and successful controls first. Test disabled profile, roles, tenant isolation, unuploaded/wrong type, exact source binding, malformed/oversized packages, stored findings without assessment wording, independent review, retries and real ledger rows.
2. Run PostgreSQL/S3 API tests with the real existing harness; validate actor separation/append-only events and integrity failures. No in-memory substitute establishes acceptance.
3. Test frontend loading/errors, source/revision/uncertainty rendering, stale responses, review role/confirmation and successful state refresh. Real browser exercise of chat upload -> report details -> independent review on desktop/mobile, plus existing brand/permission checks.
4. Run required typecheck/lint/test/build/infra/CI checks. Record skipped engine suites and external/hosted acceptance separately. Targeted guard-removal controls must fail before restoration.

## Boundaries / next slice

This persists source uploads and patient-link reviews using existing records; the laboratory view is a fresh validated projection of immutable source bytes. It does not persist normalized assay/finding tables or build a cross-report registry. Declared amendments, duplicate external accession/revision conflicts and issuer authenticity require that later reconciliation slice. Independent analytic acceptance and generated contextual assessments remain S2b/S3. Clinical release, CPIC content and all real-data gates remain closed. No inference or new dependency is used.

## Local walkthrough

Use the existing owned-storage launcher and its pinned PostgreSQL 16/Moto prerequisites (`pnpm demo:storage:build`, then `pnpm demo:storage` with explicit `LOCAL_PG_BIN` and `MOTO_SERVER`). Sign in as the synthetic clinician Alice. Attach `data/fixtures/pgx-contracts/uncertain/package.json` in chat, choose/create a synthetic patient in the details form, confirm synthetic-only content and upload. Open **All reports** within the workspace, select that filename and choose **Show structured findings**. The source ambiguity stays visible; Alice has no review action.

Use a separate browser context signed in as synthetic reviewer Gina. Open the same report and expand **Review patient link**. Choose a decision and reason, explicitly confirm the patient-reference check, and record it. Reopen the report to verify the persisted state. `amended/package.json` instead demonstrates a declared predecessor that remains unreconciled; no other source is automatically replaced. Teardown uses the launcher's exact owned run receipt.
