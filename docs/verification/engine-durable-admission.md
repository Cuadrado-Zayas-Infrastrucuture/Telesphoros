# H1 durable admission verification

Date: 2026-10-26

Scope: [inactive H1 foundation](../design/plans/engine-durable-admission.md). Synthetic fixtures only; real restricted-role PostgreSQL tests. Exact candidate, full producer exits, selected profiles and hosted state are reported with the delivery PR; complete permitted outputs remain private in `/private/tmp/telesphoros-engine-h1/`.

## Meaningful failures and repairs

- The first migrated-schema assertion reached its expected boundary: the existing queue was present while request/receipt storage was absent. The new migration made the unchanged assertion pass.
- An inactive admission stub returned its explicit not-implemented refusal. The unchanged concurrency oracle then passed through the implemented transaction: four identical admissions create exactly one request/job.
- Direct SQL accepted a numeric value formatted as a 64-digit digest. Explicit JSON string-type checks made the same invalid-profile control fail closed while its valid-profile control remained green.
- A direct SQL caller could supply a future admission timestamp. Assigning the timestamp inside the validation trigger made the same database-clock oracle pass.
- Status omitted the queue idempotency-key check. A deliberately drifted binding was initially reported queued; the unchanged control now receives refusal.
- A contained ledger initially mapped to a generic unavailable code. The same incident fixture now receives the established `LEDGER_COMPROMISED` refusal, with another organization still able to admit.

The queue-progress harness initially shared retained jobs from earlier cases. The real queue correctly claimed older work. Isolating only that lifecycle case in its own existing ephemeral database preserved its assertions and queue behavior. No production guard, ordering rule or timeout was weakened.

## Focused evidence

The two new suites currently cover 29 controls, including:

- Concurrent same-key admission, changed-manifest conflict, same-client rollback after enqueue, and reconciliation when real COMMIT succeeds but its response is lost.
- Actual database membership over spoofed caller roles; foreign/unknown IDs; read-only roles; preservation of organization work after requester removal; suspended-organization refusal.
- Observed native database lock waits for both admission/review orders. Capture or patient-link rejection committed first prevents admission; a later rejection leaves history intact and refuses stale replay.
- Missing capture/acceptance/report, unverified patient link, direct substitutions of report hash/object version/text hash, and immutable profile copies with no client-selected provider fields.
- Forced tenant RLS, a non-superuser/non-bypass application login, actual denied update/delete/TRUNCATE/completion writes, and no worker table/lock-helper rights.
- Queued/running/retry/dead status, queue success without a clinical receipt, valid completion before ACK, and refusal of mismatched receipts or job bindings.
- Empty migration down/up, nonempty history/job rollback refusal, and source-level absence of runtime API/consumer registration.

Typecheck, lint and the focused suites passed after targeted formatting. These working-tree results are not a claim that broader service profiles or hosted CI passed.

## Required delivery acceptance

The final candidate must pass typecheck, lint, workspace tests, build, infrastructure tests, CI-config tests and workflow checks. Because this adds schema and permissions, all three backend profiles require documented disposable PostgreSQL/S3 services, plus affected worker tests and both applicable F2/F3 recovery validators. Preserve profile/check artifact identity; a missing required tier or NOT RUNNING notice is missing evidence even with process exit 0.

Full service tests and existing recovery validators retain independent evidence. No mock, superuser-only query or queue acknowledgment substitutes for application-role/RLS, source/version or clinical-ledger controls. Validation failures require repair and affected checks again; CI gates and migration lint are not waived.

## Limits

H1 never reads a real model or runs the clinical engine. Synthetic profile digests prove immutable binding, not model availability, artifact provenance, equivalent provider behavior or clinical correctness. Provider manifests and retained executor bundles must be validated before a future executor is enabled. Completion-read fixtures use the owner because H1 intentionally exposes no completion writer; they prove status consistency, not H3 fenced-write security.

No new route, registered consumer, schedule, cloud resource, model call or production/clinical activation is part of this evidence. Native owned test resources must be stopped and verified after the final service run. Hosted exact-head CI remains separate from local acceptance.
