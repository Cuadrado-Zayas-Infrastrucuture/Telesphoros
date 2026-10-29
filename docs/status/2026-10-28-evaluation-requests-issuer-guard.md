# Fix: queued evaluation and the evaluation worker are refused while the session issuer is in use

Date: 2026-10-28

H4 ([spec 007](../../specs/007-async-evaluation/spec.md)) left one question open: how a background worker acts for the person who asked. On 2026-10-28 the founder chose to write a spec for that (the issuer checks the requester again when the worker claims a job), and to close the gap first with this guard.

## What was wrong

- When `ISSUER_URL` is set, every API request carries a capability from the session issuer (DATA-01).
- The evaluation worker has no request and no sign-in token, so it is issued none. It binds the tenant through the older setting.
- A request queued in that configuration would therefore be answered with less proof than the API gives the same request made directly.
- Nothing at run time checks again that the requester is still a member allowed to evaluate. The route checked once, when the request was queued.

## What changed

- `EVALUATION_REQUESTS=enabled` is refused at start-up while `ISSUER_URL` is set (`apps/backend/src/config/env.ts`). Nothing can be queued that no worker can answer correctly.
- The evaluation worker refuses to start while `ISSUER_URL` is set (`apps/backend/src/lab-reports/evaluation-worker-config.ts`).
- Both refusals name the setting and never its address.
- A comment in `evaluation-request-consumer.ts` says that the principal's `roles` is not read on this path and that the run-time membership check belongs to the worker-capability spec. The literal itself is unchanged.
- `docs/lab-report-reader.md` describes the refusal and the missing run-time check.

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
