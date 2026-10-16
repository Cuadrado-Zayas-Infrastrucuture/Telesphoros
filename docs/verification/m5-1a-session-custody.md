# M5.1a session custody — local verification

The approved slice is implemented locally on `feat/m51a-session-custody`, directly from main `7987a68`. It adds durable credential custody; no route uses it and no HTTP cookie is issued. M5.1 as a whole remains open. See [approved design](../design/plans/m5-1a-session-custody.md).

## Implemented

Migration 0026 adds a separate classified operational table with forced tenant RLS, a membership foreign key, immutable identity/lifetime/credential fields, terminal database-timed revocation, restricted column grants, and expired-only cleanup. Internal custody uses random handles stored as digests, opaque authenticated tenant locators and purpose-separated AES-256-GCM credential envelopes bound to row metadata. Lifetime is capped at token expiry or fifteen minutes without sliding extension or refresh-token custody. Keys are supplied explicitly; no production key wiring, memory fallback or scheduler was added.

## Fresh tests

| Acceptance | Result |
| --- | --- |
| Crypto / custody units | 33 passed |
| Real PostgreSQL session cases | 17 passed; app/verifier/worker/auditor/operator permissions, two-instance custody, deterministic lock waits, expiry/cleanup and non-superuser migration up/down/up |
| Focused session + existing catalog suite | 69 passed |
| Migration/CLI/restore regression selection | 133 passed across ten suites |
| Full profile 1, with PostgreSQL/Moto available | 2,136 passed; 253 expected profile skips |
| Full PostgreSQL application profile | 2,368 passed; 21 expected profile skips |
| Full PostgreSQL + S3 profile | 2,388 passed; one expected skip |
| Worker | 13 files / 123 tests passed |
| F2 independent and F3 application recovery validators | Both passed, all three profiles; six fresh aggregate artifacts retained |
| Backend typecheck, lint, build | Passed |
| Controlled defects in disposable copies | Three caught, each after a passing positive control: removed authenticated context, one-hour lifetime, broadened session RLS |

Every profile ran all 50 permanent new session cases and all 34 existing role/order probes. No required service notice was emitted. The expected skips above are profile exclusions; no new session case skipped. Targeted mutant runs intentionally selected one case each; their other test names were not selected, and are not missing acceptance. The original F06/F07 probes and browser bridge remain unchanged; frontend/browser execution was not selected for this backend-custody-only slice.

Node 22.22.0 and pnpm 10.28.0 used a frozen offline install with lifecycle scripts disabled. PostgreSQL 16/SCRAM and Moto ran only on new task-owned loopback fixtures. All native stdout/stderr and producer exits were retained before filtering. Runtime recovery artifacts report the working-tree base HEAD `7987a68`; tested source hashes bind the changed implementation/tests to the subsequent local commit. These are local runs, not exact-commit GitHub CI or hosted acceptance.

## Failures evaluated and repaired

The pre-change PostgreSQL acceptance failed because the custody table did not exist. Initial focused tests passed; typecheck identified an incompatible `import.meta` test-path expression, corrected using the existing CommonJS path convention. Wider acceptance exposed hand-written 25-migration inventories, rollback offsets and restored-schema expectations that needed the new migration's explicit PK/FK/check/index inventory. They remain independent expected values, not generated from the tested catalog. The new FK makes plain membership TRUNCATE refuse before the trigger; the test now proves both that FK refusal and the explicit CASCADE trigger refusal, with the row preserved. No existing migration or audit-drop safeguard was weakened.

The first failing profile was deliberately stopped after those failures were reproduced; its native exit -2 and logs are retained, and it is not counted as acceptance. A focused repair run exposed the remaining shared restore inventory and boundary offset; the corrected 133-test run and all three full reruns passed. The first disposable mutant harness lacked a shared-package dependency link and ran zero tests; it was repaired and never counted as a caught defect. A final control rerun had an automatic approval-review timeout before process creation; its permitted retry completed. Initial cleanup identity checking resolved localhost text; numeric identity checking then verified and stopped only the owned fixture. Full failed and successful producer receipts remain available.

## Controls and remaining limits

AuthGuard/AuthModule, live membership/commit context, app setup/configuration, roles-only `/me`, frontend, F06/F07 recovery/CORS, Actions, Terraform backend wiring and dependencies are unchanged. Both FD-7a branches/candidates, both F06/F07 sources and the combined reference are preserved. The test services were stopped after verification; data/logs retained. No AWS resource, production database, PHI, push, PR, merge or deployment was involved.

A read snapshot is not API authorization or final write admission; its share lock ends with its own transaction. M5.1b must supply login transactions, backend code/PKCE exchange, key custody/configuration, cookie/CSRF endpoints, explicit bearer/cookie selection, live verifier/membership checks and session-aware final write ordering. It must also name the bounded cleanup invoker and operating evidence. M5.1c supplies frontend and same-origin routing integration with the preserved recovery/download probes. Each later slice starts from then-current main after its prerequisite lands. Hosted Cognito/CloudFront and real session-key custody remain separately authorized acceptance.

AGENTS.md rule: yes — proposed addition within the existing schema-verification rule: update hand-written migration and restored-schema inventories before full-profile runs. No AGENTS.md file was edited.
