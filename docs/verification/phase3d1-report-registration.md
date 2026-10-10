# Phase 3D1 report-registration verification

Approved 2026-10-10; baseline `06fd007`, isolated branch `feat/phase3d-report-registration`. Synthetic repository work only. PR and final-head CI acceptance are pending until their actual results are recorded.

## Result and contract

`POST /api/v1/reports` accepts an optional UUID `requestId`. Its namespace is the authenticated tenant and creator; case variants of the same UUID are canonicalized. The original patient ID, report type, filename and declared byte size are fingerprinted as a fixed JSON tuple using SHA-256. Atomic uniqueness handles racing requests; matching retries return the same report ID and current state with the existing 201 response. Conflicting original input or a soft-deleted reservation returns 409. Unkeyed creation, DTO shape, writer authorization and existing clinical/pipeline holds retain their contracts.

The fingerprint is original metadata, not the file checksum. It survives metadata correction independently of current fields. Callers must allocate a new key for a new upload; this slice does not deduplicate file contents or persist browser retry state. Request keys/fingerprints are not exposed in report DTOs. The standard product form remains a stub and needs its own transport/UI PR.

Migration 0014 adds nullable identity/hash columns without rewriting legacy rows, a valid-pair CHECK, uniqueness on `(tenant_id, created_by, creation_request_id)` and a trigger refusing identity changes. Existing tenant/creator guards remain. Soft deletion retains the unique reservation. Application roles cannot hard-delete rows; future operator purge must account for loss of this reservation. Query execution uses parameterized values and explicit tenant predicates.

Populated rollback requires explicit `telesphoros.allow_report_retry_drop=yes`; it retains report rows but loses retry identities. Reapplying the migration does not recover removed keys. No operational rollback, production migration or remediation was executed. DDL lock waits are bounded at two seconds and execution at thirty seconds; adding constraints/indexes locks the reports table. Production-sized migration time and contention are unverified.

## Reproduction and repairs

| Observation | Diagnosis / action | Evidence |
| --- | --- | --- |
| Original unkeyed API call repeated after discarding its response created two records | Reproduced through the real API; retained as legacy compatibility control | `phase3d-baseline.log`: 1 passed / 13 deliberately unselected tests |
| New keyed-retry test failed on unchanged code (expected 201, received 400) | New contract was absent; added optional key, repository operation and migration | `phase3d-contract-red.log`, then focused memory controls passed |
| Offline install lacked a locked package in the local store | Environment blocker; frozen install with registry access succeeded, no manifest/lockfile change | `phase3d-install.log`, `phase3d-install-network.log` |
| Type checking rejected `unknown` passed to Supertest's `.send` | One test-helper annotation repair to `object`; no runtime behavior weakened | First typecheck log, then typecheck passed |
| First complete tier had two legacy repository equality failures | Mapper was adding null identity fields to unkeyed records; omit them for legacy rows and retain strict assertions | `phase3d-tier1.log`; 48 focused repository/retry controls subsequently passed |

No repeated identical failure or third unsuccessful repair was reached. Tests, refusal assertions and intended behavior were preserved.

## Executed local controls

macOS, Node 22.22.0, pnpm 10.28.0; native PostgreSQL 16 with SCRAM on a new loopback-only disposable cluster, existing Moto environment on a separate loopback port. Test databases use helper-generated names and restricted application-role connections. The uncommitted workflow setup remains in the original checkout.

- API: lost-response replay; eight concurrent retries; distinct/case-varied keys; changed patient/type/filename/size; correction replay; soft-delete refusal; tenant/creator namespaces; anonymous/reader refusals; invalid keys; unchanged unkeyed behavior and DTO privacy.
- PostgreSQL: sixteen concurrent requests through two independent restricted-role pools; conflicting request race with exactly one winner; pool recreation; immutable identity and pair validity; correction/deletion behavior; unchanged legacy migration; guarded/explicit fixture rollback; bounded lock failure with no partial DDL and successful retry.
- Injected defects: removing uniqueness fails the exact catalog gate; disabling the identity trigger makes the refusal assertion fail. Rollback restores each control and valid replay still succeeds. All mutations occurred only in helper-owned disposable databases.
- Existing current-schema built CLI backup/restore: fourteen migrations; exact preservation of three retry keys, creator/tenant bindings and original fingerprints across restore. Existing schema/privilege/RLS/ledger/tamper/refusal controls remain. Historical 3C thirteen-migration measurements remain historical; primary file availability still does not establish independent report-file recovery.

| Check | Result |
| --- | --- |
| Focused memory API/service controls | 22 passed |
| Focused PostgreSQL/API/migration/recovery suites | 86 passed across seven suites (before final mapper compatibility repair) |
| Strict legacy repository contracts plus retry controls after mapper repair | 48 passed across three suites |
| Workspace type checking, lint, build | Passed after the final mapper repair; backend build also exercised by the full current-schema CLI rehearsal |
| CI configuration guard | 28 passed |
| Other workspace suites | 194 passed, including 120 frontend tests |
| Complete backend default / PostgreSQL / PostgreSQL+S3 | 1,558 / 1,739 / 1,740 passed; 182 / 1 / 0 intentional profile skips; zero failures or missing-service notices. Durations 128.907 / 162.960 / 168.245 seconds |
| Final-head CI / inspected tier logs | Pending |

Raw local logs are retained in the task workspace under `<home>/Documents/Codex/2026-10-10/c/work/phase3d-*.log`; none is evidence of live AWS, Cognito/provider behavior or production readiness. Application/storage services and database migrations were not run against any shared or production target.

## Remaining acceptance

Inspect all final-head CI jobs and actual database tier logs, not only green status labels. Distinguish deliberate profile skips from missing services. Local browser/container rehearsals were not run; their final-head CI evidence must remain separate. Founder review/merge, standard product transport/UI, full Phase 3 acceptance, live auth/hosting/provider/scheduler/custody and independent file recovery remain open.
