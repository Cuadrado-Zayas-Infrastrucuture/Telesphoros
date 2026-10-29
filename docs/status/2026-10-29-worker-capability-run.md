# Feature: the evaluation worker runs under issuer capabilities (spec 012 slice 3, local)

Date: 2026-10-29

Slice 3 of [spec 012](../../specs/012-worker-capability/spec.md). Slice 1 (#146) lets the database issue a job capability, and slice 2 (#152) lets the issuer serve one to a signed worker. This slice makes the worker use them. On 2026-10-29 the founder chose to have the database door ask for each transaction's capability.

## What changed

- **`runWithCapability(source, work)`** (`apps/backend/src/auth/authority-context.ts`, T030). It runs worker work outside any request. Inside it, `Database.withTenant` asks the source for a NEW capability before each transaction, before it takes a connection, and binds it as it binds a request's (plan D2). A boundary test checks that only the evaluation-request consumer calls it and only the database reads the source. Request paths are unchanged: they have no source.
- **The worker's client** (`apps/backend/src/issuer/job-capability-client.ts`). It signs each call with slice 2's `signWorkerRequest`, sends it to `POST /v1/job-capabilities`, and retries once on a failed connection or a 503 with a new signed request. A separation spec keeps it to the issuer's port, the API client's address rule and capped reader, and the signing module.
- **The consumer** (T031).
  - Given the client, it runs the whole job under `runWithCapability`.
  - The person it acts for is the one the issuer names. A capability naming another person or organization, or a person who is not the requester, ends the job as `requester-not-authorized`.
  - The issuer's refusals end the job: `job-not-held`, `tenant-inactive`, and `requester-not-authorized` for `membership-not-current`, `role-not-allowed` and any other code.
  - An issuer that cannot be reached, or one that answers `unauthenticated` or `replayed`, is retried (`issuer-unavailable`, `issuer-unauthenticated`).
- **Settings** (T032, plan D4).
  - The worker reads `EVALUATION_WORKER_ISSUER_URL` and `EVALUATION_WORKER_ISSUER_KEY` together, or neither. The key follows the issuer's rule (base64url, at least 32 bytes).
  - Its refusal while `ISSUER_URL` is set now lifts only when both are set.
  - The API's refusal of `EVALUATION_REQUESTS=enabled` beside `ISSUER_URL` lifts only with `EVALUATION_REQUESTS_WORKER_BINDING=capability`. The default, `none`, keeps it.
- **Docs:** `docs/lab-report-reader.md` says what the settings do and what is still not proved.

## How it was verified

See the [verification record](../verification/worker-capability-run.md):

- An end-to-end spec on PostgreSQL with a real issuer process, covering SC-001 and every refusal in User Story 2.
- Nine mutations, each caught.
- The full local loop.

## Not changed

- Terraform: no deployment passes the worker key to the issuer or the worker. The question of whether job refusals should feed issuer.tf's alarm is still open.
- `tenant_binding_mode` stays `dual`.
- No migration.
- The API's guard path and the agentic worker.

Local only until the founder says push.
