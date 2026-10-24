# @telesphoros/backend

NestJS API (Phases 2-4). **Synthetic data only.** Storage is PostgreSQL (or in memory for quick tests) plus S3 for
report files; sign-in is Amazon Cognito (not yet applied; see [docs/auth.md](../../docs/auth.md)). See [docs/database.md](../../docs/database.md).

```bash
pnpm --filter @telesphoros/backend test        # unit + e2e (Jest)
pnpm --filter @telesphoros/backend typecheck
pnpm --filter @telesphoros/backend lint
pnpm --filter @telesphoros/backend build && JWT_SECRET=<32+ chars> pnpm --filter @telesphoros/backend start
```

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
  with SSL, S3, and https CORS origins. Details: [docs/auth.md](../../docs/auth.md).
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
