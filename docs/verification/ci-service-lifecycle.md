# Service lifecycle review repairs — local verification

Approved local repair on 2026-10-16 (Puerto Rico), addressing both findings on `3f9171396f0bcf764e0c247b8523cf9913d85bf0`. Branch `fix/ci-service-lifecycle` starts directly from refreshed main `1da75b1b5ff55cceb195136dbcb2ebbd805235a0` and carries the unpublished candidate without stacking. Original `3f91713` and `bd9b6cb` references/checkouts remain preserved. The bounded read-only PR inventory found only #146 OPEN/draft, unchanged at `9904bd1c3ff46ece562dfb4f8e5d7775966be190`.

## Changes and invariants

| Finding | Repair | Preserved controls |
| --- | --- | --- |
| Normal shell completion killed Moto after readiness | A native-zero exit before the absolute deadline hands persistent children to the job watchdog. Job completion still cleans them. | Failed, signalled and expired shells retain descendant cleanup and native failure/124 status. A final clock check refuses a late zero; no new time is granted. |
| Supervision errors omitted bounded worker escalation | Expiry and error paths share one shutdown helper: TERM, bounded descendant cleanup, the existing owner grace, identity-checked owner KILL fallback and repeated/final new-process sweeps. Receipt failure cannot skip shutdown. | Scan failures retain the last successfully read snapshot; every signal still verifies live PID/start/UID. Signal errors remain failures and cannot bypass the final escalation attempt. |

The only workflow change relative to `3f91713` is regeneration of the exact embedded canonical supervisor. All four Moto startup heredocs, profile pipelines, job graph, action pins, permissions, artifact settings and mandatory joining steps are byte-identical. Every preexisting CI test file and fixture remains byte-identical; seven lifecycle controls are added in a separate file. Application source/tests, test discovery, worker settings, package/lockfiles and recovery validators remain unchanged against main. The prerequisite producer still hashes to `e6d5b83b6b287f0267dc549ff57f146c0ed49c35c447896be238af91ed4ef689`.

The clock schema, validation and arithmetic remain byte-identical: exactly `run_started_at + 30 minutes`, current-attempt identity binding and no reset. Existing 500 ms process cleanup and at most five-second worker shutdown grace remain failure cleanup, not additional acceptance time. Existing 30-minute job caps are unchanged. Platform provisioning before the first executable step remains outside the watchdog, as documented in the preceding candidate.

## Local evidence

Complete permitted stdout/stderr and native exit receipts are retained outside the checkout in this chat's `work/ci-service-lifecycle-repair/`. Pinned Node 22.22.0 and pnpm 10.28.0 were used. Local CI configuration controls do not start hosted CI or service profiles.

| Check | Native result | Evidence and limits |
| --- | --- | --- |
| New regression suite before repairs | exit 1: 6 failed, 1 passed | Moto survival, late-zero refusal and bounded error shutdown failed. Failed setup already preserved exit 17 and cleaned its service (`red-lifecycle`). |
| Seven lifecycle controls after repairs | exit 0: 7 passed | Exact four identical Moto startup scripts extracted from the workflow; finite local command stand-ins prove survival, later job-owned cleanup, native failure cleanup and late-zero refusal. Heartbeat, transient/persistent scan and TERM errors prove owner escalation; available scans also sweep late detached work (`green-lifecycle-2`). |
| Entire CI configuration suite | exit 0: 94 passed, 0 failed/skipped | `pnpm test:ci-config`, including all 87 preexisting controls for native failures, pipefail, signals, action cancellation, detached children, profiles and joining-gate refusal (`all-local-controls`). |
| Workspace controls | exit 0: 8 passed, 0 failed/skipped | `node --test scripts/workspace-build/workspace.test.cjs` (`workspace-controls`). |
| Actual committed report reader | exit 0; wrapper status 124 | Source transpiled in memory, application files unchanged. Detached child dead at wrapper return, no runner marker inherited, no late output; return about 702 ms after the synthetic deadline including cleanup (`actual-reader`). |
| Three isolated defect injections | Harness exit 0; each targeted control exit 1 | Restored premature success cleanup; omitted bounded shutdown on supervision errors; removed final job-owned daemon cleanup. All detected in scratch copies (`mutations`). |
| Exact scope assertions | exit 0 | Existing tests/fixtures/evidence helpers, complete workflow outside the embedded source, clock prefix and protected application/config/producer trees unchanged; original 3f91713 checkout and refs preserved (`final-scope-2`). |
| Working-tree secrets and whitespace | exit 0 | Existing gitleaks configuration with redaction; `git diff --check` (`local-secrets`, `whitespace`). |
| Workflow syntax | exit 0 | `actionlint -color .github/workflows/ci.yml` (`syntax`). |

The first repaired test run exposed an assertion in the new controls that assumed every dead-process lookup returned null. The Darwin adapter also returns undefined when its process table contains no live entry. New controls now assert absence; the original assertions are untouched. The original red failures were live process records or incorrect status, so they remain distinguishable. Earlier failed output is retained. The final scope check includes intent-to-add files, compares application/configuration against main and the carried prerequisite producer against its exact `3f91713` bytes.

## Safety, limitations and remaining acceptance

Native tests signal only their explicit finite fixture children and use injected PID tables for job-wide selection. The Moto control opens no network port and installs no dependencies. Fixture deletion is confined to newly generated synthetic directories; children are cleaned or self-expire. No existing service, real runner or production data is touched.

Production process selection remains restricted to a non-root dedicated standard hosted Linux X64 VM with verified Runner.Worker ancestry. Baseline protection and live PID/start/UID checks are unchanged. If the process scan remains unavailable, the helper forces bounded owner shutdown and attempts cleanup of previously verified identities. It cannot discover unseen new processes while inspection is unavailable; no unsafe unchecked PID or UID-wide fallback is added.

Actual GitHub-hosted Linux cancellation/post actions, full backend/worker execution and runtime comparison remain unrun. Local Moto behavior uses native process stand-ins rather than an installed emulator. No publication, hosted CI, rerun, merge or deployment occurred. Local success does not establish hosted acceptance or runtime improvement.

Next: review this local candidate. A later separately authorized hosted run must prove every complete profile and required check within the unchanged attempt window. No test/profile removal or timeout increase is proposed.

Session: `codex://threads/01a1468a-60c3-74a2-baa3-0ad59f19cf34`.
