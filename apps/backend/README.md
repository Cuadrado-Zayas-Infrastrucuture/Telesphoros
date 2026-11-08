# @telesphoros/backend

NestJS API (Phases 2-4). **Synthetic data only.** Storage is PostgreSQL (or in memory for quick tests) plus S3 for
report files; sign-in is Amazon Cognito (see [docs/auth.md](../../docs/auth.md)). What runs where: [docs/ops/environments.md](../../docs/ops/environments.md). See [docs/database.md](../../docs/database.md).

```bash
pnpm --filter @telesphoros/backend test        # unit + e2e (Jest)
pnpm --filter @telesphoros/backend typecheck
pnpm --filter @telesphoros/backend lint
pnpm --filter @telesphoros/backend build && JWT_SECRET=<32+ chars> pnpm --filter @telesphoros/backend start
```

## Where to start

[`src/main.ts`](src/main.ts) starts the API and [`src/app.module.ts`](src/app.module.ts) registers every domain module. This package has three other entry points: [`src/db/cli.ts`](src/db/cli.ts) (the `db:*` commands: migrate, backup, restore, each with its own database login), [`src/issuer/main.ts`](src/issuer/main.ts) (optional, with its own enable switch) and [`src/evaluation-worker.ts`](src/evaluation-worker.ts) (gated). The queue worker is a different package: [`apps/worker`](../worker). Documentation map: [docs/README.md](../../docs/README.md).

### Folders that look alike

| Folder | What it is |
| --- | --- |
| `src/auth/` | Verifies the token, builds the `Principal`, enforces `@Roles`. [`membership.service.ts`](src/auth/membership.service.ts) reads the caller's current roles from the database on every request |
| `src/members/` | HTTP routes for an organization's administrators over their own people. It creates no account and no organization |
| `src/membership/` | Operator commands ([`membership-cli.ts`](src/membership/membership-cli.ts), [`tenant-cli.ts`](src/membership/tenant-cli.ts)) that run with the migration login. There is no API route for them ([membership runbook](../../docs/ops/membership.md)) |
| `src/storage/` | Record storage: an abstract repository class with an in-memory implementation beside it and a PostgreSQL one in `postgres/`. [`storage.module.ts`](src/storage/storage.module.ts) picks one from `STORAGE_DRIVER` |
| `src/object-storage/` | File bytes only: in memory or S3, picked from `OBJECT_STORAGE_DRIVER` in [`object-storage.module.ts`](src/object-storage/object-storage.module.ts). Separate from record storage |
| `src/db/` | Database infrastructure: the pool, the migrator, the `db:*` CLI, backup and restore, the evidence catalogue |
| `src/services/` | The clinical engines and readers behind a generic name: knowledge loading, the phenotype and recommendation engines, the report adapter, the optional report reader and the offline `report-lookup` |
| `src/ledger/` | The per-tenant hash-chained audit ledger. A change here must keep the tenant and the transaction in view |

### Direction of dependencies

- A request goes controller, then service, then an abstract repository from `src/storage/`. No controller or service runs SQL at this commit. Record SQL lives in `src/storage/postgres/` and the migrations; the ledger ([`src/ledger/`](src/ledger)), [`src/auth/session-admission.ts`](src/auth/session-admission.ts) and [`src/db/`](src/db) also run SQL of their own.
- Every repository method takes the tenant id, and it comes from the `Principal`, never from the request body.
- The stores are chosen in `storage.module.ts` and `object-storage.module.ts`, but they are not the only readers of `STORAGE_DRIVER`: `auth/auth.module.ts`, `health/health.module.ts`, `config/env.ts`, `reports/intake/local-policy.ts`, `patient-identity/structured-preview.service.ts` and `storage/ledger-records.repository.ts` read it too. Search for it before assuming a change is independent of the store.
- A change to a repository touches the abstract class and its in-memory implementation (the same file) and the PostgreSQL implementation. Run the API suite on both stores, `pnpm test` and `pnpm test:db` (the second needs `TEST_DATABASE_URL`); a green in-memory run says nothing about the SQL.

### One traced path: create a patient

1. **UI.** [`NewPatientPage.tsx`](../frontend/src/pages/NewPatientPage.tsx) shows [`PatientCreateForm.tsx`](../frontend/src/components/patients/PatientCreateForm.tsx), which calls `createPatient` in [`api.ts`](../frontend/src/lib/api.ts). It parses the body with the shared schema and `POST`s `/api/v1/patients` with a retry `requestId`.
2. **Contract.** `patientCreateSchema` in [`packages/shared-types/src/patient.ts`](../../packages/shared-types/src/patient.ts); the controller validates the same schema with `ZodValidationPipe`.
3. **Controller and service.** [`patients.controller.ts`](src/patients/patients.controller.ts) (`@Roles(...CAN_WRITE)`, the clinician) calls [`patients.service.ts`](src/patients/patients.service.ts), which replays a prior creation with the same `requestId` and returns a DTO through [`patients.mapper.ts`](src/patients/patients.mapper.ts).
4. **Repository.** `PatientsRepository` and `InMemoryPatientsRepository` in [`src/storage/patients.repository.ts`](src/storage/patients.repository.ts); the PostgreSQL one in [`src/storage/postgres/patients.repository.ts`](src/storage/postgres/patients.repository.ts).
5. **PostgreSQL.** The `patients` table is made in [`0001_core_tables`](migrations/0001_core_tables.up.sql); the retry record in [`0039_patient_creation_requests`](migrations/0039_patient_creation_requests.up.sql). Row-level security by tenant: [docs/database.md](../../docs/database.md).
6. **Tests.** [`patients.service.spec.ts`](src/patients/patients.service.spec.ts) and [`patients.mapper.spec.ts`](src/patients/patients.mapper.spec.ts) (unit); [`test/patients.e2e-spec.ts`](test/patients.e2e-spec.ts) (the API, in-memory store); [`test/db/patient-registration.pg-spec.ts`](test/db/patient-registration.pg-spec.ts) (PostgreSQL, needs `TEST_DATABASE_URL`).

### Where a change goes

Every row also needs a new numbered migration when it changes the schema (never edit an applied one: [docs/database.md](../../docs/database.md#migrations)), and a status fragment ([CONTRIBUTING](../../CONTRIBUTING.md)).

| Task | Contract and UI | Server | Tests | Read first |
| --- | --- | --- | --- | --- |
| Add a patient field | The traced path above. A name or birth date is different: it goes through [`src/patient-demographics/`](src/patient-demographics) (encrypted per patient, migration `0064`) | `src/patients/`, `src/storage/patients.repository.ts` and `postgres/` | As above, plus [`test/db/patient-demographics.pg-spec.ts`](test/db/patient-demographics.pg-spec.ts) for demographics | [spec 025](../../specs/025-patient-demographics) |
| Change upload validation | [`REPORT_CONTENT_TYPES`](../../packages/shared-types/src/report.ts); the browser check ([`productUploadSchema.ts`](../frontend/src/lib/productUploadSchema.ts)) is advisory | [`src/reports/intake/`](src/reports/intake): `intake.service.ts`, `structural-validator.ts`, `stage.ts`, `scope.ts`, `local-policy.ts` | `src/reports/intake/*.spec.ts`, [`test/reports-upload.e2e-spec.ts`](test/reports-upload.e2e-spec.ts), [`test/local-storage-intake.e2e-spec.ts`](test/local-storage-intake.e2e-spec.ts) | [docs/ops/report-evidence.md](../../docs/ops/report-evidence.md) |
| Change a clinical gate (the pipeline or the synthetic assessment) | Build flags in [`storageMode.ts`](../frontend/src/lib/storageMode.ts) | `LAB_REPORT_PIPELINE` and `SYNTHETIC_ASSESSMENT` start-up rules in [`src/config/env.ts`](src/config/env.ts); the route guard [`src/lab-reports/pipeline-switch.ts`](src/lab-reports/pipeline-switch.ts); [`structured-assessment.controller.ts`](src/lab-reports/structured-assessment.controller.ts); the Terraform side in [`api-compute.tf`](../../infrastructure/terraform/api-compute.tf) | [`test/lab-reports-gate.e2e-spec.ts`](test/lab-reports-gate.e2e-spec.ts), [`test/synthetic-assessment.e2e-spec.ts`](test/synthetic-assessment.e2e-spec.ts), `pnpm test:infra` | [the switch](../../docs/ops/synthetic-assessment-switch.md), [the reader](../../docs/lab-report-reader.md) |
| Add a job | A new `defineJob` in [`packages/jobs/src/definitions.ts`](../../packages/jobs/src/definitions.ts) | A consumer in [`apps/worker/src/handlers/`](../worker/src/handlers) registered in [`apps/worker/src/main.ts`](../worker/src/main.ts); the database function and the schedule or outbox route in a migration (see [`0023_jobs`](migrations/0023_jobs.up.sql), [`0024_outbox_consumers`](migrations/0024_outbox_consumers.up.sql)) | `apps/worker/test/*.pg.test.ts` (need `TEST_DATABASE_URL`) | [docs/ops/jobs.md](../../docs/ops/jobs.md) |
| Change who may do what | `Role` in [`packages/shared-types/src/roles.ts`](../../packages/shared-types/src/roles.ts) and the frontend's [`roles.ts`](../frontend/src/auth/roles.ts), which must match the API | `@Roles(...)` on the controller, [`roles.guard.ts`](src/auth/roles.guard.ts), [`clinical-read.ts`](src/auth/clinical-read.ts), `tenant_memberships` ([`0017_membership`](migrations/0017_membership.up.sql)) | [`test/auth.e2e-spec.ts`](test/auth.e2e-spec.ts), [`test/membership.e2e-spec.ts`](test/membership.e2e-spec.ts), [`test/no-role-reads.e2e-spec.ts`](test/no-role-reads.e2e-spec.ts), [`test/db/membership.pg-spec.ts`](test/db/membership.pg-spec.ts) | [docs/auth.md](../../docs/auth.md#authority-and-revocation) |

On the gate row: `PGX_CLINICAL_HOLD_LIFTED` is named in [the AI safety requirements](../../docs/ai-safety-and-hallucination-controls.md) but no code under `apps/` or `packages/` reads it at this commit, so there is nothing to change for it here. Enabling clinical processing is its own approved intention, never a side effect of another change.

## Endpoints (all under `/api/v1`)

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET | `/health` | public | **Liveness**: the process is up. Never touches dependencies. |
| GET | `/me` | any token | The caller's roles and nothing else (the UI uses it to decide what to show) |
| GET | `/ready` | public | **Readiness**: safe to receive traffic. Runs dependency checks (the database joins in Phase 3); `503 SERVICE_UNAVAILABLE` while any is down. |
| GET, POST | `/patients` | any token / `clinician`,`admin` | Paginated list; create |
| GET, PUT, DELETE | `/patients/:id` | any token / `clinician`,`admin` | PUT replaces; delete is refused (409) while reports exist |
| GET, POST | `/reports` | any token / `clinician`,`admin` | Metadata only; optional UUID `requestId` makes registration retryable for that tenant/creator. Status is always set by the system. |
| GET, PATCH, DELETE | `/reports/:id` | any token / `clinician`,`admin` | PATCH corrects `type` / `filename`; DELETE is a soft delete |
| GET | `/reports/:id/upload-state` | `clinician` | The report's upload revision (the token a declaration must carry) and the organization's reservation status |
| POST | `/reports/:id/upload-attempts` | `clinician` | Declare an upload: `requestId`, `revision`, `contentType`, `sha256` (replaying the same declaration returns the attempt) |
| PUT | `/reports/:id/upload-attempts/:attemptId/bytes` | `clinician` | The raw bytes, with `X-Upload-Revision`: the server validates, stores, pins and commits |
| POST | `/reports/:id/upload-attempts/:attemptId/resume`, `/cancel` | `clinician` | Reconcile a lost reply; cancel (both need `X-Upload-Revision`) |
| GET, POST | `/reports/:id/structured-preview`, `/record`, `/review`, `/source-resolution`, `/patient-link` | `clinician`,`reviewer` to read and save; `reviewer` to review | Structured reports only. Owned local runs, or `SYNTHETIC_ASSESSMENT=enabled` (synthetic staging); a reviewer cannot review evidence they uploaded or saved |
| POST | `/reports/:id/structured-assessment` | `clinician`,`reviewer` | Only with `SYNTHETIC_ASSESSMENT=enabled`: assesses the reviewed revision against synthetic knowledge and stores an evaluation. See [docs/architecture.md](../../docs/architecture.md#the-synthetic-assessment-synthetic-staging-only-spec-032-s3) |

The lab-report pipeline routes (captures, decisions, evaluations, corrections, disputes) are in [docs/architecture.md](../../docs/architecture.md) and answer 503 unless their switch is on.

Health vs ready: use **health** for "restart this process if it fails", and **ready** for "stop
routing traffic here if it fails". A database outage must fail *ready* but not *health*, or an
orchestrator would restart healthy processes in a loop.

## Contracts (shared with the frontend via `@telesphoros/shared-types`)

- **Errors**: always `{ "error": { "code", "message", "details?", "requestId" } }`. Switch on `code`
  (`VALIDATION_ERROR`, `BAD_REQUEST`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`,
  `PAYLOAD_TOO_LARGE`, `RATE_LIMITED`, `SERVICE_UNAVAILABLE`, `INTERNAL_ERROR`).
  Codes are stable: add, never rename. `details` are `{ field, message }` and never contain the submitted value.
  No stack traces or raw exceptions in API error logs; fixed event/status/code fields are logged against the `requestId`.
- **Lists**: `{ "data": [...], "meta": { "page", "pageSize", "total", "totalPages" } }`.
  `pageSize` defaults to 20 and is capped at 100; unknown query parameters are rejected.
- **Request id**: every response carries `X-Request-Id` (also in the error body). A caller may send
  its own (8-64 chars of `A-Z a-z 0-9 . _ -`); anything else is replaced.
- **Inputs are strict**: unknown fields are rejected (no mass assignment). Caller-supplied unknown field names are not echoed in errors. Endpoints without a body/query declaration reject nonempty undeclared input before business logic; absent bodies and empty JSON objects remain valid for bodyless actions. Authentication/authorization runs first. Response DTOs are checked
  against the same schemas, and internal fields (tenant, author, storage keys) never appear.

## Authentication and authorization

- Every route requires `Authorization: Bearer <JWT>` unless marked `@Public()` (only health and ready).
- Roles: `reader` (read only), `clinician` (read + change), `admin` (reserved). A token with no roles is least privilege.
  `@Roles(...)` on a route requires at least one of them; otherwise `403 FORBIDDEN`.
- **Tenancy**: every record belongs to the caller's tenant (an organization; the token's single `tenant:<id>` group) and
  every repository method takes the tenant id, so colleagues share records. The token's `sub` is only recorded as the
  author (`created_by`). Another tenant's record is reported as `404 NOT_FOUND` (not 403), so ids cannot be probed. A
  genuine token whose user has no tenant group, or two, is refused with `403 FORBIDDEN`. See [docs/auth.md](../../docs/auth.md).
- Tokens are verified for signature, issuer, expiry and an issued-at no older than 1 hour. All rejections return the same
  generic 401. Two verifiers: **`cognito`** (production): RS256 Cognito *access* tokens against the pool's published keys
  (`client_id` and `token_use=access` checked; ID tokens, HS256 and `alg: none` refused; an unreachable key set answers 401,
  never 500); **`hmac`** (development and tests only): a shared secret.
- **Production fails closed:** `NODE_ENV=production` starts only with the Cognito verifier, no development overrides, PostgreSQL
  with SSL, S3, and https CORS origins. `NODE_ENV` has no default: the API refuses to start without it, so a missing setting cannot
  mean development. Details: [docs/auth.md](../../docs/auth.md).
- **CORS** is an exact-match allowlist (`CORS_ALLOWED_ORIGINS`); empty means no cross-origin access. No cookies are used.

## Configuration

Validated at startup (`src/config/env.ts`); errors name the variable and rule, never the value.
See `.env.example` at the repo root. Real secrets belong in AWS Secrets Manager, never in git.

## Decisions worth knowing

- **NestJS 11 (CommonJS), not 12.** Nest 12 and `jose` 6 are ESM-only, which Jest cannot run without
  experimental flags. Moving to Nest 12 means an ESM migration of the backend and its test runner.
- **Storage sits behind repository interfaces** (`src/storage`). Phase 3 added the PostgreSQL
  implementations behind the same abstract classes; controllers did not change. Each repository call is a single query
  (no per-row follow-ups). The database orders by an identity `seq` column, so creation order holds even when timestamps tie.
- **Logs** are structured JSON (pino): request id, method, matched route template (no path parameters or query string), status, user id. Unmatched or guard-rejected requests use `[unmatched]`.
  Authorization/cookie headers are redacted; bodies are never logged.
- Rate limiting and CORS are implemented; see `docs/ops/rate-limiting.md` and `docs/auth.md`. Live provider provisioning, security-header closure and scheduled operational verification remain separate phases.

## Configuration (Phase 3 additions)

| Variable | Meaning |
| --- | --- |
| `AUTH_VERIFIER` | `hmac` (default; dev/test) or `cognito` (the only one allowed in production) |
| `COGNITO_REGION`, `COGNITO_USER_POOL_ID`, `COGNITO_APP_CLIENT_ID` | required for `cognito` (from the Terraform outputs) |
| `COGNITO_ISSUER`, `COGNITO_JWKS_URI` | development-only overrides, for the fake identity provider; **refused in production** |
| `CORS_ALLOWED_ORIGINS` | comma-separated browser origins allowed to call the API (default none) |
| `STORAGE_DRIVER` | `memory` (default) or `postgres` |
| `DATABASE_URL` | the **application** login role (required for `postgres`); **no TLS parameters in the URL** (refused) |
| `DATABASE_SSL` | `disable` (default, development only) or `require` (TLS 1.2+, certificate and host name verified; required in AWS); the only TLS setting, see [database.md](../../docs/database.md#database-tls) |
| `DATABASE_SSL_CA` | path to the authority file the `pg_dump`/`pg_restore` tools verify against when `DATABASE_SSL=require` (falls back to `NODE_EXTRA_CA_CERTS`) |
| `OBJECT_STORAGE_DRIVER` | `memory` (default) or `s3` (AWS S3 or S3-compatible such as MinIO) |
| `REPORTS_BUCKET`, `AWS_REGION`, `S3_ENDPOINT`, `S3_FORCE_PATH_STYLE` | S3 settings; credentials come from the standard AWS provider chain, never from our config |
| `DATABASE_MIGRATOR_URL`, `DATABASE_ADMIN_URL` | read only by the `db:*` CLI (migrations; backup/restore), never by the API |

## Tests

A plain `pnpm test` needs no services and runs against the in-memory store. The database tier (schema, row-level
security, repositories, backup/restore, readiness) and the S3 tier are enabled by `TEST_DATABASE_URL` /
`TEST_S3_ENDPOINT`, and a plain run prints which tiers it skipped. Details and commands: [docs/database.md](../../docs/database.md).
