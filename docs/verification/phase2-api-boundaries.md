# Phase 2 API boundaries — verification record

## Scope and reproduction

Fresh base `fa063bf` (PR #50); first of three founder-approved Phase 2 closure slices. The new privacy test failed on the baseline because a synthetic marker in the exception and URL reached actual pino logs. Public error responses already withheld it.

The production filter now logs fixed `api-error`, request id, status and error code. HTTP completion records log the matched route template captured by the input interceptor; raw request URLs, parameters, query strings, headers and bodies are omitted. Unmatched/guard-rejected routes use `[unmatched]`. Automatic HTTP error objects omit raw errors too. The existing `ledger-compromised` top-level event test remains unchanged.

The interceptor uses existing whole-body/query Nest parameter metadata as the contract, after guards and before pipes/handlers. Its test inventories all 13 source controller classes and 33 routes, checks their parameter validation pipes and exercises undeclared input rejection for every route. Missing bodies and empty objects are allowed for bodyless actions; arrays, null, primitives and nonempty objects are refused. Framed bodies that the JSON parser did not consume (for example text/plain) are refused. Body-consuming routes retain their existing strict schema pipes. Unknown-field error wording no longer echoes client-supplied key names.

## API audit

| Controller group | Body/query contracts | Response control |
| --- | --- | --- |
| Patients, reports, recommendations | Strict body/query/UUID schemas; empty-input interception elsewhere | Explicit allowlisted patient/report/recommendation DTO mappers; main lists already paginated |
| Captures and report capture | Strict UUID/decision bodies; no body for capture/link requests | Capture/acceptance/file-link DTOs, source keys excluded |
| Evaluations and report evaluation | Strict evaluation-create/filter/UUID inputs | Explicit full/summary mapping; pagination and batching remain separate open slices |
| Corrections and notes | Strict correction body/UUID inputs | Correction/note DTOs; notes remain authorized response data, never log data |
| Disputes | Strict decision/create/filter/cell-usage/UUID inputs | Explicit dispute/cell-usage mapping; dispute-list pagination remains open |
| Ledger, health, readiness, me | Strict ledger query; empty input for probes/me | Fixed readiness/identity summaries; global role/auth controls retained |

Existing tenant isolation, wrong-role/token, mass-assignment and DTO privacy tests are retained. Source review plus tests over the current inventory is bounded evidence; it does not establish universal future privacy or clinical validity. The startup/bootstrap logger and unrelated service-specific logs are outside this filter-focused slice.

## Verification

- Targeted privacy/boundary/validation/alarm checks: 39 passed, including unsupported bodies and an attached HTTP error. Clean full local backend run: 1,091 passed; 180 external-tier tests explicitly skipped.
- Backend typecheck, lint and build passed on Node 22.22.0 (Unicode 16.0.0).
- Defect records: `phase2-api-boundary-defects.json`; each deliberate mutation must fail an assertion, with source restored afterward.
- PostgreSQL application-role/S3 emulator tiers: required CI; inspect the PR checks for their final result. Local default run explicitly skips external tiers; no AWS resources or real PHI.

## Compatibility and limits

Callers sending ignored nonempty bodies or queries now receive 400 `VALIDATION_ERROR`; empty JSON objects on bodyless actions remain supported. Unsupported framed request-body content types are rejected. This intentionally tightens input acceptance without changing response DTOs, clinical rules or stored records. Body/query parameter metadata is a Nest integration dependency pinned by the inventory and real HTTP tests. Losing raw exception details is intentional; diagnostics retain correlation and stable codes. Pagination, N+1 reads, live deployment and clinical acceptance are not closed by this PR.
