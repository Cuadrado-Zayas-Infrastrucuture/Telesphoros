# Service deadline supervision — local verification

**Historical candidate `3f91713`:** later review reproduced premature Moto cleanup on successful setup and missing bounded owner escalation on watchdog errors. The superseding local repairs and evidence are recorded in [service lifecycle verification](ci-service-lifecycle.md). Earlier local green results below did not cover those cases.

Approved repair of the two review findings on `bd9b6cb891429efbd17217c5859db90d7b04de97`, performed 2026-10-16 (Puerto Rico). Branch `fix/ci-service-deadline-supervision` starts directly from refreshed main `1da75b1b5ff55cceb195136dbcb2ebbd805235a0`; the unpublished isolation slice is carried forward without stacking. Current main's session-custody changes are preserved. The original reviewed checkout and refs remain unchanged. The last read-only PR check found #146 OPEN/draft at `9904bd1c3ff46ece562dfb4f8e5d7775966be190`.

## Findings and repairs

| Finding | Cause | Repair |
| --- | --- | --- |
| Active actions outlive the shared deadline | A relative download timeout calculated during initialization becomes stale; setup and uploads have no independent absolute-deadline supervisor. A final check prevents late acceptance but cannot stop active work. | The first step arms a detached supervisor before checkout/setup. It cancels the current Runner.Worker and terminates newly created runner-user processes when the original attempt deadline arrives. All four jobs require the same canonical supervisor and a live, identity/source/clock-bound heartbeat. Initialization verifies that clock instead of fetching or resetting it. |
| Detached reader children survive wrapper expiry | Group-only termination misses the actual report reader's `detached: true` child; killing its parent also removes the parent's cleanup timers. | Native shell wrappers record descendant process identities across groups, freeze captured descendants before losing ancestry, and terminate/escalate before returning. The job supervisor also detects new same-user processes after reparenting, without depending on inherited tracking variables. |

The canonical module is `.github/ci/service-deadline.mjs`. Its exact contents are embedded once in the workflow with a YAML anchor, reused by all four jobs and checked for drift by the existing CI guard. `update-service-deadline.mjs` regenerates only that embedded copy. The bootstrap uses the hosted image's preinstalled Node and built-ins before checkout; application Node 22.22.0 and pnpm 10.28.0 remain unchanged. No new credential permission is added.

The accepted deadline remains exactly `run_started_at + 30 minutes`, bound to repository, run ID, attempt, head and checkout. Queue, setup, transfer, test and upload time consume that window. Expiry starts cancellation immediately; the 500 ms process cleanup grace and at most five-second worker shutdown grace are bounded failure cleanup, not additional time for acceptance. VM provisioning, service-container initialization and action-download preparation precede workflow code; the first executable step refuses an already-expired attempt. This implementation cannot cancel platform work before that step runs. Existing 30-minute job caps remain defense in depth.

## Local evidence

Complete permitted stdout/stderr and native exit receipts are retained outside the checkout in this chat's `work/ci-deadline-repair/`. Earlier failed iterations remain alongside corrected runs. These are local control results, not hosted acceptance or application-profile execution.

| Check | Native result | Evidence / limit |
| --- | --- | --- |
| Initial action-supervision regression | exit 1 | Two new checks failed before repair (`red-action-supervision`). |
| Actual committed backend reader reproduction | Before: exit 1; after: exit 0 | Reader transpiled in memory using the existing compiler. Repaired wrapper returned 124; child was no longer alive and no late marker appeared (`detached-reader-fixed`). Application source unchanged. |
| Unwrapped action and orphaned detached child | Pass | Native fixture owner receives cancellation, active action and detached minimal-environment child stop, late markers remain absent, and a preexisting fixture process remains alive. Injected process tables contain only explicit fixture PIDs. |
| Resistant owner / early owner exit | Pass | Shutdown-resistant owner is killed after bounded grace; completed owner disarms without waiting for the deadline. |
| Final `pnpm test:ci-config`, pinned runtime | exit 0; 87 passed, 0 failed/skipped | Includes all 16 new deadline controls, Linux `/proc` file fixtures, receipt failure controls and existing native failure/pipefail/signal controls (`final-pnpm-ci-config`). |
| Combined CI and workspace controls | exit 0; 95 passed, 0 failed/skipped | `node --test .github/ci/*.test.mjs scripts/workspace-build/workspace.test.cjs` (`all-local-controls`). Subsequent Linux executable-identity hardening was covered by the final 87-check run; the eight unchanged workspace controls were not rerun. |
| Four isolated defect injections | Harness exit 0; each targeted run exit 1 | Omitted active-owner cancellation, restored original group-only wrapper, missing required-watchdog validation, and 31-minute shared budget were each detected (`mutation-controls`). Mutations were confined to scratch copies. |
| Workflow syntax | exit 0 | `actionlint -color .github/workflows/ci.yml` (`final-actionlint`); syntax does not prove GitHub lifecycle execution. |
| Working-tree secrets | exit 0; no leaks | `gitleaks dir --redact` with the existing configuration (`final-secrets`). |
| Scope preservation | exit 0 | Exact tree/script assertions preserve application trees against current main, main's custody additions, all four profile pipelines against bd9b6cb, original tests and evidence validators, six other jobs, required ruleset and main supersession cancellation (`scope-preservation`). |

The prerequisite producer still hashes to `e6d5b83b6b287f0267dc549ff57f146c0ed49c35c447896be238af91ed4ef689`, identical to the published first slice. Application tests, discovery, profiles, worker settings, package/lockfiles, test deadlines, all nine recovery aggregates and both joining-gate validators are unchanged. CI regression controls are added, not removed or weakened.

## Cleanup blast radius and controls

Machine-wide selection is allowed only for a non-root standard GitHub-hosted Linux X64 job with an actual same-user Runner.Worker ancestor. Workstations, self-hosted runners, unsupported platforms and unknown ancestry fail closed before starting producers. On that dedicated VM, only processes created after the protected baseline with the current job UID are selected; owner/self and baseline identities are excluded. Before each signal the live PID, start identity and UID must still match. No environment or argument values are inspected or logged. Linux owner identification uses `/proc/PID/exe`, not a mutable thread title.

Local tests never enable machine-wide cleanup: finite synthetic children and explicit PID whitelists bound their blast radius. Fixtures self-expire if assertions fail. The native descendant wrapper is limited to its own launched tree. A failed or stale monitor receipt, unavailable inspection, source/clock drift or failed bootstrap refuses acceptance. Failure artifacts run only after successful arming and are best effort within the same deadline.

## Remaining acceptance and source basis

Actual hosted Linux execution, Runner.Worker cancellation, post-action behavior, all backend/worker profiles and total service-path runtime remain **unrun**. Docker's daemon was unavailable locally; it was not started. No hosted CI, rerun, publication or merge was initiated. No runtime improvement is claimed. A separately authorized hosted run must demonstrate all required checks and complete profiles within the original attempt window; compare the entire service path from the attempt clock, not only the joining job's displayed duration.

Adapter assumptions were checked against official sources: GitHub documents a fresh VM for standard [hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners), supports [workflow YAML anchors](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations), and defines [step timeout behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idstepstimeout-minutes). The runner's [Worker.cs](https://github.com/actions/runner/blob/main/src/Runner.Worker/Worker.cs) forwards unloading/SIGTERM to runner shutdown; [JobRunner.cs](https://github.com/actions/runner/blob/main/src/Runner.Worker/JobRunner.cs) binds shutdown to the linked job cancellation token. The [Ubuntu 24.04 image inventory](https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md) includes preinstalled Node. These source checks support the design; they do not prove the exact installed runner's behavior.

Session: `codex://threads/01a1468a-60c3-74a2-baa3-0ad59f19cf34`.
