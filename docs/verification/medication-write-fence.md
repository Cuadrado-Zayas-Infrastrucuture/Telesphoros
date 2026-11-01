# Medication-write fence verification

Date: 2026-11-01. Base: merged historical compatibility `4de1324`.

The requested separate change adds a default-disabled medication POST setting, an API task setting defaulting false, a fixed client pause message, and explicit enablement in synthetic capture fixtures. Reads and authorization still apply. See the [contract and operational limits](../ops/medication-write-fence.md). No live account, task, migration, clinical rule or source artifact was changed.

## Red-first evidence

Against unchanged application code, the new environment-default test failed because the setting was absent, and the default-fenced HTTP test failed because its POST returned 201 instead of 503. That run also exposed the existing retired-ingredient retry race: the four concurrent identical requests sometimes returned three 201s and one 409. The early stale-version path now rechecks replay, preserving the original assertion. After implementation, 117 focused configuration/real-PostgreSQL HTTP/database tests passed.

The new frontend pause test failed against the old client, which showed the generic error rather than the specific fixed pause text; the existing fourteen cases passed. The infrastructure guard failed against the old Terraform for the absent default-closed variable and API environment value. No assertions were weakened. Session red/green logs are in `/workspace/recovery/medication-fence/` (local session paths, not published evidence URLs).

## Scope of evidence

The fenced HTTP case checks create/correction/stop/replay refusals, reader/cross-tenant denial, readable historical data, unchanged row/event count and ledger verification. Reopening saves the exact refused request once and replays it idempotently. Synthetic tests explicitly enable capture when needed; omission still tests the real disabled default. API unit configuration tests reject ambiguous values such as `true` and `on`.

The frontend unit suite mocks HTTP to isolate retained form values, retry identity and fixed error handling. Browser acceptance uses a built API, actual migrated PostgreSQL/non-owner login, Moto and the fake RS256 issuer, with no medication API responses mocked. The infrastructure tests inspect configuration text and run the application's loader; they do not prove AWS behavior, rollout completion or request draining. Current release tools do not support a same-image flag transition; no guard was widened to hide this limitation.

Final test/browser results are recorded below after completion. No skipped tier is a pass.

## Final local results

- All six required repository commands passed: typecheck, lint, test, build, infrastructure (215) and CI configuration (217). Frontend 683 passed; backend memory 2,077 passed / 450 skipped. Five absent private-reader specs remain excluded. The new PostgreSQL case is among the memory-tier skips and was exercised separately on the real service.
- Focused configuration plus real PostgreSQL HTTP/database: 117 passed, then three complete confirmations of the same 117 after the exposed retry race was repaired. The original four-concurrent-identical-request assertion is intact. Removing the fence check made the new refusal test fail (201 instead of 503); restoring it restored all passes. The infrastructure controls also reject default-true and missing-task-setting mutations. Pinned Terraform formatting and the five-test workflow pack passed.
- Browser: two fenced-profile cases and eight explicitly enabled storage cases passed. Both profiles use mobile/desktop, both themes and axe. Fenced tests prove fixed pause text, retained fields/request id, no saved-success state, no created entry and readable current data. Enabled tests retain 20-entry density, retired identity correction/stop, roles/history, lost-response and concurrent-correction coverage at 375/390/768/1280px. The existing loss case deliberately aborts one response to exercise retry; medication responses are otherwise real. Desktop dark pause evidence was inspected manually.
- The task's isolated browser database/login were dropped and the owned test cluster stopped. No test services were left running. No AWS identity is configured in this environment. No live plan, apply, publication, write-fence rollout/drain or migration was attempted.

Backend S3, worker-service and FHIR tiers were not rerun locally for this change; a skip is not a pass. Existing release-script/plan controls and the real local Terraform stale-plan rehearsal were checked separately before implementation (38 controls plus one real Terraform check), using stand-ins for AWS and a temporary built-in Terraform backend respectively. Those checks do not establish live readiness. Hosted results, when available, belong in the PR.
