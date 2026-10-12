# L3 local implementation verification

Verified locally on 2026-10-12, from main `08629e6` containing merged L2 PR #79. Implementation branch: `feat/local-storage-operations`. No push, PR creation, remote CI, merge or AWS action is claimed by this receipt.

## Implemented

The [operations runbook](../ops/local-storage-operations.md) describes the separate owned runner, native PostgreSQL cluster/Moto lifecycle, restricted application role, atomic manifest/control receipts, startup and 15-minute reconciliation, admission closure on sweep failure, explicit recovery, and full-state teardown. Existing clinical runner code, application/migration code, AWS resources and production data were not changed. A frontend test config reuses L2 browser assertions against L3-owned services.

The test-only multipart writer reuses the existing streaming validation boundary, then exercises real Moto assembly and authenticated API resume/download. It does not introduce product multipart transport or browser storage credentials.

## Tests

| Check | Result |
| --- | --- |
| Workspace typecheck, lint, build | Passed |
| CI configuration guards | 35 passed |
| Ownership, scheduling, admission and clock unit controls | 9 passed |
| L2 browser assertions on L3-owned PostgreSQL/Moto | 16 passed, mobile and desktop |
| Real PostgreSQL/S3 cleanup, intake, bounds, journal and clock suites | 45 passed, zero skips |
| Workspace backend regression | 1,225 passed; 201 announced service-dependent skips, supplemented by the real suites above |
| Other workspace suites | Frontend 197; SMART 186; CPIC 36; shared types 22; fake IDP 7; notifier 9 passed |

Operational acceptance passed setup, synchronized clocks, effective non-owner RLS, all three browser file formats and exact attachment bytes, multipart part ordering/replacement/ETag/size faults, lost replies, receipted abort, chunked raw intake, form-data/size/disconnect refusal, actual killed-writer staging recovery, database-authoritative grace boundaries, admission close/reopen, and preserved exact pins despite newer versions.

Lifecycle acceptance passed repeated teardown, both partial setup failures, a missing/tampered manifest, preserved foreign sentinel, SIGINT shutdown, SIGKILL launcher recovery, and fresh setup with no inherited simulated IAM/policy, bucket/object or multipart state. The rehearsal confirms clinical tables remain empty. The final regression stack was also removed; no owned run directories remained.

Runtime: Node 22.22.0, PostgreSQL 16.14, Moto 5.2.3, local Playwright Chromium. The runner records non-secret resource identities and bounded aggregate outcomes. Its JSON lives at `.local-storage/rehearsal.json`; the delivery evidence copies it alongside source/log hashes outside the removed run directories.

## Risks and limits

**Moto signed-URL expiry is a recorded verification gap:** the actual signed attachment remained HTTP 200 after its 60-second expiry. The rehearsal labels this `emulator-gap`, not a provider pass. Simulated IAM state disappearance demonstrates disposal, not AWS policy enforcement, Object Lock custody, provider recovery, or production readiness. No AWS request was used to fill those gaps.

Runtime state is disposable and uses loopback trust authentication; real records are prohibited. Teardown deliberately destroys all synthetic bytes in the exact owned run, while orphan sweeps preserve committed pins. Missing ownership or incomplete cleanup fails visibly and retains resources. The manifest/control copies are a local ownership guard, not protection against a malicious actor with the same OS account.

## Repairs verified during implementation

- Set the explicit C locale required by native macOS PostgreSQL startup.
- Provision PostgreSQL 16 membership inheritance correctly and check effective journal privileges before starting the API.
- Account for Python's macOS interpreter re-exec while pinning process start, script and arguments.
- Wait through the macOS exiting-process command placeholder without signaling it again; require completed exit before removal.
- Separate intake staging from browser/compiler caches and close startup probe connections before blocking browser tooling.
- Close API admission even when reconciliation fails before the cleanup library can record a stalled state; reopen only after an affirmative sweep.

## Follow-ups

L3 draft PR and required hosted CI remain delivery steps when requested. Provider expiry, custody and production-readiness gates remain separate and unresolved. No merge is authorized.
