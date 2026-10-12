# Synthetic correction history verification

Verified locally on 2026-10-11, from main `aa91225`. Scope: [approved plan](../design/plans/synthetic-correction-history.md) and [display contract](../ops/correction-history-preview.md). Synthetic fixtures only; no deployment or real patient data.

| Check | Result | Local evidence |
| --- | --- | --- |
| Pilot tests | 168 tests across 7 files passed, including correction chain refusals, content withholding, polling, expiry, hidden/offline cleanup and late-response rejection | [test log](/private/tmp/corrections-tests-final.log) |
| Actual backend/API integration | 8 tests passed against local PostgreSQL and S3 emulator, including retraction, independent reinstatement, supersession and explicit replacement selection | [integration log](/private/tmp/corrections-real-api-final.log) |
| Workspace typecheck, lint and build | Passed | [typecheck](/private/tmp/corrections-types-workspace.log), [lint](/private/tmp/corrections-lint-workspace.log), [build](/private/tmp/corrections-build-workspace.log) |
| Final pilot build | Passed | [build log](/private/tmp/corrections-build-pilot-final.log) |
| Freshness defect injection | Removing the server freshness guard caused the targeted test to fail: expected 422, received 200. Restored the guard and reran the passing pilot suite | [mutation log](/private/tmp/corrections-mutation.log) |
| Built viewer in Chrome | Active/retracted/reinstated/superseded/failed-read phases passed; all five evidence requests were GETs, two PDF links revoked, no page errors | [results](/private/tmp/corrections-browser.json), [screenshot](/private/tmp/corrections-browser.png), [harness](/private/tmp/corrections-browser.cjs) |
| Existing real OpenEMR browser regression | Two synthetic launches, read-only FHIR, consent withholding and cleared fragments passed | [browser log](/private/tmp/corrections-openemr-browser.log) |

The correction browser harness serves synthetic evidence responses to the built viewer. Actual correction transitions are verified separately through the backend's existing authenticated APIs and real local database. The OpenEMR regression uses the existing static synthetic registration. These checks do not claim one complete OpenEMR-to-stored-backend correction workflow; full workflow acceptance remains a later slice.

The actual reader test asserts nine GETs and unchanged evaluation/ledger counts for the history-only read. Existing cross-tenant, cross-patient, forged-credential, pipeline-off and invalid source-link refusals remain exact refusals. Valid unavailable selections now explicitly assert a null bundle and empty profile while retaining verified history. No PDF is downloaded for ineligible evidence, and no replacement is chosen automatically.

Retention settings, clinical gates, backend production routes/schema and existing rate limits are unchanged. A 30-second freshness budget and normal 15-second rechecks bound staleness under normal browser scheduling; they do not provide push invalidation, atomic snapshots or revocation of saved PDFs. Core R4 schema checks do not establish genomics implementation-guide conformance.

Remaining planned slices: terminology/implementation-guide validation and full synthetic workflow acceptance.
