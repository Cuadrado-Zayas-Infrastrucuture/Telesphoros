# Medication-write fence

Date: 2026-11-01. Application/configuration control prepared for review; no live rollout or operational drain has been rehearsed.

`MEDICATION_WRITES` accepts only `disabled` or `enabled` and defaults to **disabled**. Upgrading an API without explicitly opening this setting pauses medication recording. Terraform exposes `medication_writes_enabled`, a boolean defaulting to false, in the API task environment. Local synthetic capture demos and the normal acceptance profile explicitly enable it; the dedicated fenced browser profile explicitly disables it.

While disabled, every authorized medication POST returns 503 with fixed reason `medication-writes-fenced`, including adds, corrections, stops and retries of previously saved requests. The setting is checked after patient access, before medication replay, reads or inserts. The refusal reserves no retry id and writes no medication row/event. Authorized current/history GETs remain available; role checks, tenant checks and input validation remain in force. A refusal does not prove an earlier attempt was never saved: after reopening, retry the same unchanged request id to discover or create its one result. The form keeps its values and retry id and shows a fixed pause message without displaying server-supplied text.

## Rollout boundaries

This is a **per-process startup setting**, not a hot switch, database-level lock, global patient-write fence or migration lock. Changing a task definition affects replacement tasks only. Requests admitted by an enabled old task may finish. Do not declare writes fenced until all serving API tasks are confirmed disabled and prior requests/transactions have drained; account for background/import/direct database writers separately. Existing patient, upload, report and worker writes are unaffected. The setting does not replace the broader drain/maintenance requirements of breaking migration 0066.

For medication capture cutover, first keep writes disabled, run the separately approved migration, roll API/worker/verifier to compatible artifacts, confirm every serving task and validate the ledger/list alignment. Opening recording is a separate release decision after those observations. Closing recording later also needs rollout/drain confirmation; merely updating an environment value is not an instantaneous fence. Old binaries that ignore the setting must not be counted as fenced.

## Current release-tool limit

The existing `MIGRATE`, `IMAGE` and `INFRA` release scripts deliberately accept fixed shapes and canonical variable-file changes. They do not provide a same-image configuration-only transition for this flag. The new Terraform environment value can also introduce task-definition changes that the current MIGRATE/INFRA shapes refuse. **Stop on those refusals.** Do not edit the canonical variable file by hand, rewrite approval hashes, widen a guard, register an ad hoc task revision or pretend an IMAGE rollout establishes a completed drain.

Before live use, prepare a separately reviewed configuration/cutover path that preserves identity, exclusive claim, saved-plan/hash/state checks, restricts the exact flag delta and confirms rollout/drain. Rehearse closure and reopening with in-flight/retry cases and retain target/version evidence. This PR supplies the application fence and deployment setting; issue #248's operational-fence acceptance remains open until that work and release approval are complete. Nothing here authorizes an apply, publication or deployment.
