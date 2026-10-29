# Feature: the session issuer serves job capabilities to a signed worker (spec 012 slice 2, local)

Date: 2026-10-29

Slice 2 of [spec 012](../../specs/012-worker-capability/spec.md). Slice 1 (#146, migration 0056) lets the database issue a job capability. This slice lets the issuer serve one to the evaluation worker, which has no sign-in token. On 2026-10-29 the founder chose replay protection shared through the database.

## What changed

- **Signed requests** (`apps/backend/src/issuer/worker-signature.ts`, plan D1). The worker signs each request with HMAC-SHA256. The signature covers:
  - a version tag;
  - the method and the path;
  - a millisecond timestamp;
  - a random nonce;
  - the SHA-256 of the exact body.

  The issuer compares the signature in constant time, then the timestamp (60 s either way). The file uses Node's crypto only, so the worker can sign with it in slice 3.

- **A new route**, `POST /v1/job-capabilities`, taking `{jobId, workerId, requestId}`.
  - It exists only when the issuer has `ISSUER_WORKER_KEY`, which must be base64url and at least 32 bytes. Without the key, the route answers 404.
  - A missing, wrong or stale signature, or a changed body, is refused 401 `unauthenticated` before the body is parsed and before the database is reached.
  - On success it returns `{token, expiresAt, membershipVersion, tenantId, sub}`.
  - The database's refusal codes (`job-not-held`, `role-not-allowed`, …) pass through as 403 `refused`.
  - `/v1/capabilities` is unchanged.
- **Migration 0057** (`compat: expand`): `issuer_request_nonces` and `issuer_nonce_claim(caller, nonce)`.
  - The function is owned by the capability owner and executable only by the issuer login.
  - A nonce is accepted once, on any issuer task. A copy answers 401 `replayed`.
  - Each claim forgets nonces older than 10 minutes. A request can only be replayed for 120 s at most, so that is well past the window.
- **Login checks.** `provision-logins.ts` now also checks who may call 0056's and 0057's functions and that no login can read the nonce table, each only once its migration is applied.

## How it was verified

See the [verification record](../verification/worker-capability-issuer-route.md):

- Tests seen failing first.
- Two real issuer processes on one database, which proves a copy is refused by the other task too.
- Nine mutations, each caught.
- The full local loop.

## Not changed

- The worker (slice 3).
- The API, Terraform (where the key would come from in a deployment) and CI.
- `tenant_binding_mode` stays `dual`, and the guard (#141) stays in force.

Local only until the founder says push.
