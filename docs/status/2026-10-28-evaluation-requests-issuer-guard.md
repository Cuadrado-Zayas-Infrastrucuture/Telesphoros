# Fix: queued evaluation and the evaluation worker are refused while the session issuer is in use

Date: 2026-10-28

H4 ([spec 007](../../specs/007-async-evaluation/spec.md)) left one question open: how a background worker acts for the person who asked. On 2026-10-28 the founder chose to write a spec for that (the issuer checks the requester again when the worker claims a job), and to close the gap first with this guard.

## What was wrong

- When `ISSUER_URL` is set, every API request carries a capability from the session issuer (DATA-01).
- The evaluation worker has no request and no sign-in token, so it is issued none. It binds the tenant through the older setting.
- A request queued in that configuration would therefore be answered with less proof than the API gives the same request made directly.
- The database does check again when the result is stored: `evaluation_completion_check` (migration 0051) requires the person acting to be the requester and still an active clinician or reviewer. But in the `dual` binding mode that person is a setting the worker supplies, not one an issuer proved.

## What changed

- `EVALUATION_REQUESTS=enabled` is refused at start-up while `ISSUER_URL` is set (`apps/backend/src/config/env.ts`). Nothing can be queued that no worker can answer correctly.
- The evaluation worker refuses to start while `ISSUER_URL` is set (`apps/backend/src/lab-reports/evaluation-worker-config.ts`).
- Both refusals name the setting and never its address.
- A comment in `evaluation-request-consumer.ts` says that the principal's `roles` is not read on this path, and where the database checks the requester again. The literal itself is unchanged.
- `docs/lab-report-reader.md` describes the refusal and what the stored-result check does and does not prove.

## How it was verified

See the [verification record](../verification/evaluation-requests-issuer-guard.md):
- Two new tests were seen failing first; the controls (the issuer unset, or queued evaluation off) pass.
- Four mutations, each caught by the test meant for it.
- The full local loop.

## Not changed

- No migration. The database's `tenant_binding_mode` row stays `dual`; the application login cannot read it.
- The issuer, `auth.guard.ts`, Terraform and CI workflows.
- Neither `EVALUATION_REQUESTS` nor the evaluation worker is set by any deployment. `ISSUER_URL` is set only when Terraform's `enable_issuer` is on.

The worker-capability spec must land before any migration moves `tenant_binding_mode` to `capability`, or before either switch is used beside the issuer.
