# M5.1b-1: internal session-aware write admission

Founder approved the local build on 2026-10-16, from current main `1da75b1`. This is the first part of the proposed M5.1b backend milestone. It does not enable cookie authentication or complete M5.1b/M5.1.

## Contract and existing boundary

Reuse `Database.withTenant`, `membership_assert_current` and the immutable M5.1a `browser_sessions` row. Custody reads still return snapshots whose lock ends with that read; they cannot authorize a later protected write. Add a trusted, non-secret session binding to the existing request authority context and recheck it on the write's own PoolClient, after the existing membership check and before COMMIT. No schema change or new privilege is needed. Migrations 0026/0027 and all earlier migrations remain unchanged.

The optional binding contains only tenant, handle digest, issued-at and creation/expiry milliseconds; subject and membership version remain in the surrounding authority. The binder owns a frozen copy and drops any additional fields. A present malformed/undefined session binding refuses instead of reverting to bearer authority. A session bound to another tenant, subject, handle or immutable timestamp cannot authorize a write. No cookie, access token, PKCE secret, CSRF value or encryption key enters this context.

The database first checks the current membership version and holds its shared lock, then locks the tenant-scoped session row shared. A materialized query checks the row's subject, immutable metadata, terminal revocation and database-time expiry after acquiring the session lock, including after a wait. Both locks remain held through COMMIT/ROLLBACK. Changed membership remains 403 and uses the existing refusal recorder. Invalid/expired/revoked session identity is 401. Unavailable session authority, pool failure, lock timeout or deadlock is a generic 503 without database details. Ordinary bearer error/authority behavior is retained.

A revocation that commits before final session admission makes the protected transaction roll back whole. A writer already holding final admission can commit before revocation, which waits for that writer. Expiry is evaluated at final database admission after lock waits; this is not a claim that wall-clock expiry can interrupt an executing COMMIT or recall returned data or an existing signed download URL. Existing read-only transaction semantics remain admission-time reads; future cookie guards must reject invalid sessions before any read handler.

Existing `asOrganizationWork` exceptions remain limited to reconciliation/empty-transfer cleanup. A revoked transfer cannot subsequently pin a report version; cleanup can still finish, and a completed but unpinned object retains unresolved organization-owned recovery state. No blanket exception for request-driven writes is added.

## Scope and limits

Production changes are limited to `auth/authority-context.ts`, new `auth/session-admission.ts` and `db/database.ts`. Permanent unit and real-PostgreSQL/HTTP tests exercise the dormant binding. The real bearer guard remains unchanged; only a test-local wrapper binds a synthetic session after the real identity/membership guard succeeds. Cookie-only requests still receive 401.

No route, cookie issuance, provider registration, credential selection, frontend conversion, CSRF implementation, runtime setting/key, dependency, scheduler, Actions change or Terraform main/backend wiring is included. The session repository remains unregistered. All 70 M5.1a cases, 19 F06 and 38 F07 probes, plus the separate browser bridge remain intact. Verification results belong in the [verification record](../../verification/m5-1b-1-session-admission.md), with full native evidence retained in the task workspace.

## Follow-ups before cookie authentication

- M5.1b-2: durable one-time login state and supersession, backend PKCE/code exchange, verified token expiry exposure, pre-auth operational storage/grants and bounded cleanup.
- M5.1b-3: validated default-off runtime configuration, purpose-separated secret custody, explicit bearer/cookie selection, session bootstrap, Origin/CSRF/generation checks, login/logout endpoints and fail-closed auditing.
- The future logout transaction must take membership then session locks consistently and authorize the terminal transition explicitly. Calling the ordinary session-bound write wrapper to revoke its own session would correctly fail the post-write active-session check and roll revocation back. Do not work around that with a blanket organization-work bypass. The mixed-order test models ordered revocation explicitly; it is not an implemented logout endpoint.
- The future guard must match verified retained-token identity/expiry to custody metadata and resolve live membership on every request. A session snapshot is not authorization. Browser generation/supersession state is a separate lifecycle mechanism, not this immutable session tuple.
- M5.1c: product frontend lifecycle, old/cached clients, cross-tab and late-response behavior, same-origin routing and actual HTTPS browser integration. Hosted Cognito/key custody/CloudFront acceptance remains separately authorized.

Every later intention starts from then-current main after its prerequisite lands. Preserve both FD-7a candidates, F06/F07 source branches, the combined reference and merged M5.1a reference. No publication, merge, live migration, cloud operation or deployment is authorized by this local slice.
