# Historical medication compatibility verification

Date: 2026-11-01. Base: merged source review `c36a02c`.

## Contract

After a source-list refresh retires an ingredient, physicians can still correct its dates/source/status or stop the existing entry. The submitted list version must acknowledge the current installed catalog. For an absent code, the service reads the latest version of that same entry within the caller's tenant and patient, checks the code and expected version, and derives the canonical name and original source-list version from persistence. The appended version retains that provenance. A listed replacement still uses the current catalog. The retired-ingredient form deliberately keeps identity read-only; for a different ingredient, stop the old entry and record a new currently listed ingredient.

The request fingerprint remains based on the original submitted fields, so a retry acknowledges the same request even when stored provenance refers to an older catalog. The transactional repository's optimistic insert check remains authoritative if another edit occurs between read and insert. History is append-only; no migration, code remapping or historical rewrite occurs. Missing catalogs still fail closed.

## Regression reproduction

Before the fix, new real-PostgreSQL HTTP regressions for stop and correction both failed: all four concurrent requests returned 400 instead of 201. Nine existing/negative cases passed. The new frontend stop/correct cases failed because the recorded ingredient was absent from the form; the twelve existing cases passed. After the fix, both focused files passed: 23 PostgreSQL HTTP/database tests and 14 frontend tests, including axe checks. No assertions were weakened.

The database cases verify retained canonical name/list version, unchanged earlier history, one row/event per concurrent idempotent request, stale/request-reuse rejection and ledger verification. Negative requests cover new retired entries, borrowed entry codes, wrong patient/tenant, reader writes, stale catalogs and unknown codes. The synthetic list fixtures are injected only in tests; they are not clinical source data. Frontend unit tests mock HTTP to isolate form behavior; the real HTTP/database tier validates persistence separately.

Session logs and visual evidence are under `/workspace/recovery/historical-medications/`; these are local paths, not published evidence URLs. Final repository/browser checks are recorded after completion below.

## Final checks

All six required local commands passed: typecheck, lint, workspace tests, build, infrastructure (215) and CI configuration (217). Frontend: 682 tests passed. Backend memory tier: 2,076 passed / 449 skipped, including the three new service-backed cases that were exercised separately on real PostgreSQL. Five absent private-reader specs remain excluded. The final focused PostgreSQL rerun passed all 23 tests. Removing only the same-entry RxCUI equality guard made the negative test fail as intended (a borrowed retired code returned 201 instead of 400); restoring the guard restored all 23 passes.

The real storage browser run passed seven of eight cases initially; the new desktop case sampled contrast during a theme transition. The test now uses the existing density suite's finite-animation settling procedure without changing any contrast assertions or production styles. Both new mobile/desktop cases then passed. The other six existing cases (density, role/history capture, lost-response retry/concurrent conflict, each in both profiles) passed in the first run. The historical cases exercise stop and correction among 20 entries, both themes, 375/390/768/1280px widths, no horizontal overflow, at least 44px recorded-drug controls, axe and actual saved version/provenance responses. Mobile light and desktop dark screenshots were inspected manually. The historical fixture uses the real repository and ledger writer on an isolated migrated database with a non-owner login; the browser uses the fake RS256 issuer, real API and Moto with no mocked API responses.

S3 backend suites, worker-service suites and FHIR validation were not rerun for this change; no pass is claimed for skipped tiers. The browser's HTTP-loss case deliberately aborts one response, as before, to exercise idempotent retry. No clinical rule, list artifact, dependency, schema, live infrastructure or legal permission changed.

Final frontend lint and the agent workflow pack (five tests) passed after the browser-test edit. The owned browser database/login were dropped and the test cluster was stopped after verification. No task services were left running.
