# M1.4: no-store responses and tenant-correlated logs

Status: **implemented on a draft PR, awaiting review.** Slice M1.4 of the [repo audit and build plan](repo-audit-and-build-plan.md), closing research-audit findings **E06** (no explicit `no-store` on authenticated clinical metadata) and **O02** (request logs lack a tenant). The founder asked to start M1.4 on 2026-10-13; the scope below is the one recorded in that plan. Verification is in [m1-4-no-store-tenant-logging.md](../../verification/m1-4-no-store-tenant-logging.md).

## Problem

- `GET /api/v1/patients` and every other route except the download-link route returned no `Cache-Control`. A browser or an intermediary may then keep patient and report metadata and its error answers (401, 403, 404, 429) and reuse them, for example after sign-out or on a shared workstation.
- Request logs carried `userId` but no tenant, so an operator could not tell which organization a failing or slow request belonged to. The existing `ledger-compromised` log line already uses a top-level `tenantId`.

## What changes

1. **Server, one place.** A middleware, `noStoreMiddleware`, sets `Cache-Control: private, no-store` on every response. It is registered in `configureApp` straight after the request-id middleware, before routing, so it covers success responses, validation and parse errors, 401, 403, 404, 429 and the public health and readiness probes. The download-link route keeps its own identical header.
2. **Logs.** `pinoHttpOptions().customProps` adds `tenantId` from the verified principal, next to `userId`. The exception filter adds the same field to its `Request rejected` and `Request failed` lines. The value comes only from the principal that `AuthGuard` sets from the verified token, never from a header or query; unauthenticated requests carry no `tenantId`.
3. **Browser client.** The authenticated request wrapper in `AuthProvider` sends `cache: 'no-store'`, after the caller's options so a caller cannot override it. Defence in depth: the server header is the control, this stops the browser HTTP cache from keeping the response even if a proxy drops the header.

## What this does not touch

- Authorization, roles, tokens, sessions and membership (M1.5).
- The security-event audit store and sensitive read/export events (M1.6). The audit's T04 text also lists those events; they stay with M1.6.
- Log field names that the `ledger-compromised` alarm depends on (`log-shape.spec.ts` still passes), and the existing log privacy rules (no tokens, URLs, query strings or bodies in logs).
- Database, migrations, Terraform, the CDN or any hosted setting.
- Sign-out behavior. Sign-out already ends in a full-page navigation to the identity provider, and tokens and clinical data are held in memory only, so a page reload discards them. A real-browser back-navigation check against a hosted deployment stays part of T13 hosted acceptance.

## Decisions

None for the founder. Two choices made here, easy to reverse:

- **Public probes are also `no-store`.** A cached readiness answer would be wrong; the cost is nothing.
- **`tenantId` in logs.** An organization identifier, not patient data. If the founder considers tenant ids sensitive in diagnostics, the field can be hashed or dropped in one line.

## Verification plan

- New end-to-end tests: `Cache-Control` on 200, 201, 400, 401, 403, 404, 429 and the probes; tenant present on authenticated completion and failure logs and absent on unauthenticated ones, including a spoofed `X-Tenant-Id` header.
- New unit test: the browser wrapper sends `cache: 'no-store'` even when a caller asks for `force-cache`.
- Each new rule proved by breaking it: tests run against the unchanged code fail (8 of 8 backend, 1 frontend); a temporary header-sourced tenant makes the spoofing control fail.
- Full local runs of typecheck, lint, build and all three backend tiers, then the required CI checks on the PR head.
