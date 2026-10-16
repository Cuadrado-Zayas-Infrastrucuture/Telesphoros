# M5.1a session custody — local verification

The approved slice is implemented locally on `feat/m51a-session-custody`, directly from main `7987a68`. It adds durable credential custody; no route uses it and no HTTP cookie is issued. M5.1 as a whole remains open. See [approved design](../design/plans/m5-1a-session-custody.md).

## Implemented

Migration 0026 adds a separate classified operational table with forced tenant RLS, a membership foreign key, immutable identity/lifetime/credential fields, terminal database-timed revocation, restricted column grants, and expired-only cleanup. Internal custody uses random handles stored as digests, opaque authenticated tenant locators and purpose-separated AES-256-GCM credential envelopes bound to row metadata. Lifetime is capped at token expiry or fifteen minutes without sliding extension or refresh-token custody. Keys are supplied explicitly; no production key wiring, memory fallback or scheduler was added.

## Initial d16d27f verification

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

## Approved clock repair — locally verified

A subsequent read-only review reproduced two defects despite the initial green suites: the original cross-clock timestamp check blocked immediate revocation with an application clock 25 seconds ahead, and a read waiting past expiry could return custody when the application clock lagged PostgreSQL by 20 seconds. Both reproducers are now permanent in `test/db/browser-session.pg-spec.ts`; they failed against the unchanged implementation before the fixes were applied. No credentials are printed by their failure comparisons.

Migration 0027 replaces only the cross-clock revocation comparison with a finite-timestamp check, preserving migration 0026's checksum, forced RLS, grants, immutability, actual database-stamped revocation and expired-only cleanup. The read query materializes the share-locked candidate before its final database-time expiry predicate. Two more permanent cases cover nonfinite timestamps/application INSERT refusal and atomic downgrade refusal until incompatible expired custody is cleaned; non-superuser up/down/up now covers both migrations. Explicit migration/restore inventories and rollback counts include 0027 without changing the original audit safeguards.

Fresh focused acceptance is 107 passed, including all 54 session cases, 19 catalog cases and 34 role/order probes. Migration/CLI/restore acceptance is 137 passed across ten suites. Backend typecheck, lint and build passed. The full profile results are:

| Profile / producer | Passed | Expected skips | Total |
| --- | --- | --- | --- |
| Default, with PostgreSQL and Moto available | 2,140 | 253 | 2,393 |
| PostgreSQL application | 2,372 | 21 | 2,393 |
| PostgreSQL + S3 | 2,392 | 1 | 2,393 |
| Worker | 123 | 0 | 123 |

Every backend profile passed all 54 session cases (17 crypto, 16 custody, 21 PostgreSQL) and all 34 existing catalog role/order probes, with no missing-service notices. Both F2/F3 validators passed for all three profiles; six fresh aggregate artifacts are retained. Tests used Node 22.22.0, pnpm 10.28.0, PostgreSQL 16/SCRAM and task-owned loopback Moto. All application/package source hashes stayed fixed during the full runs. Runtime recovery artifacts name the working-tree starting HEAD `d16d27f`; source hashes bind these runs to the subsequent local repair commit. No exact-head GitHub CI or hosted acceptance is claimed.

Evidence is retained under `work/m51a-clock-fix-verification/` in the task workspace, with distinct producer names per attempt. Both permanent clock cases failed against the unchanged original implementation, then passed after the repairs. The first focused invocation used a nonexistent helper-test path; its other 73 tests passed, but that invocation is not acceptance. The corrected complete selection passed all 107. No full profile failed or required a source repair during this follow-up. Existing crypto/context/lifetime/RLS mutation evidence remains historical and separate; it was not rerun here.

The owned PostgreSQL/Moto services were stopped after verification, retaining their data and logs. Both FD-7a candidates, F06/F07 source branches, combined reference and catalog branch are preserved. All earlier migration SQL checksums, active bearer authentication, frontend, Actions/main wiring and dependencies remain unchanged. The downgrade refusal is deliberate when retained rows cannot satisfy the former cross-clock ordering; retry only after normal expiry cleanup. No live migration, AWS operation, push, PR or deployment occurred. M5.1b/c and all hosted authentication/key-custody/browser acceptance remain open.
