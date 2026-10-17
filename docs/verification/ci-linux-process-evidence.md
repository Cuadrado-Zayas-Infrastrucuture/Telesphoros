# Linux process identity and service evidence repairs — local verification

Approved local implementation on 2026-10-16 (Puerto Rico), following investigation of PR #148 at `8af0b5954091b6ddf750ecc6cc3e78a9a64f0710`. Branch `fix/ci-linux-process-evidence` starts directly from refreshed main `1da75b1b5ff55cceb195136dbcb2ebbd805235a0` and carries that candidate locally. The original PR #148 branch and checkout remain unchanged. No publication, CI dispatch/rerun or merge is authorized or performed.

## Repairs and preserved contracts

| Failure | Repair | Preserved refusal |
| --- | --- | --- |
| A denied same-UID `/proc/PID/exe` read aborts the whole process scan | Treat only executable EACCES/EPERM/ENOENT/ESRCH as unavailable optional identity. Retain PID/PPID/start/UID and set command to an empty string. | Core metadata errors and unexpected executable errors still propagate. Runner ownership still requires the actual verified executable on the ancestor chain. Mutable comm cannot become owner authority. Cleanup still selects and revalidates retained identities before signals. |
| Fresh inode timestamps can precede a wall-clock start sample | Refuse all pre-existing expected profile metrics, including dangling symlinks. Before execution, exclusively create/write a private marker on the output filesystem, read its bigint timestamp/device and remove only that marker. Compare new regular metric files with that filesystem fence. | Equal coarse-tick timestamps are valid; older/backdated output, another device, invalid schemas, failed producers and expired clocks are refused. Existing files are never refreshed/deleted to make a producer pass. No mtime tolerance or sleep is added. |

The only workflow change relative to #148 is regeneration of its embedded canonical deadline module. Everything outside that embedded body is byte-identical: all profile pipelines, job graph, required gate, action pins, permissions, service images, environment and 30-minute job limits. `service-budget.mjs` remains byte-identical, including Moto preservation, native status/pipefail handling, cancellation and detached-child cleanup. The clock remains exactly `run_started_at + 1,800,000 ms`; no phase resets it. The existing owner shutdown grace remains bounded failure cleanup, not acceptance time.

Every pre-existing test file is byte-identical to #148. Seventeen controls are added in `service-linux-regression.test.mjs`; package scripts and discovery remain unchanged. Application code/tests, recovery validators, fixtures, prerequisite producer, runtime pins, packages/lockfile and required rules remain unchanged. The worker path does not create a metric fence. The marker leaves no extra file in metric bundles or the nine-file joining result.

## Local verification

Pinned Node 22.22.0 and pnpm 10.28.0 on macOS. Complete permitted stdout/stderr and native exit receipts are retained outside the checkout in this chat's `work/ci-linux-process-evidence/`.

| Check | Native result | Scope |
| --- | --- | --- |
| New regressions against unmodified #148 implementation | exit 1: 6 passed, 11 failed | Red proof for executable denial/disappearance, retained cleanup targets, coarse-tick acceptance, pre-existing output and fence error handling. Existing negative cases already refused. |
| Same regressions after repairs | exit 0: 17 passed, zero failed/skipped | Actual-shaped Linux adapter fixtures inject narrowly scoped read errors; signal spies avoid touching any real runner. Evidence tests call the actual producer with valid synthetic metrics and controlled filesystem times. |
| `pnpm test:ci-config` | exit 0: 111 passed, zero failed/skipped | All 94 existing controls plus the 17 additions. Includes native failure/pipefail, signals, Moto lifetime, watchdog errors, action cancellation, detached children, absolute budget and all joining-gate refusals. |
| `node --test scripts/workspace-build/workspace.test.cjs` | exit 0: 8 passed, zero failed/skipped | Existing shared-library orchestration controls. |
| `node --test .agents/scripts/check-workflows.test.mjs` | exit 0: 4 passed, zero failed/skipped | Existing workflow-pack controls. |
| Existing three adversarial lifecycle controls, pointed at this checkout | exit 0: 3 passed, zero failed/skipped | Native finite children: a loopback synthetic service survives later zero/17 steps; watchdog errors clean owner/service; default 5-second shutdown forced a resistant owner to stop in 5,058 ms; cancellation cleans a child detached during owner exit. No real runner is signalled. |
| Canonical bootstrap regeneration and actionlint | exit 0 | Generated source guards pass in the full CI suite; workflow syntax passes. |
| `git diff --check` | exit 0 | No whitespace errors. |

The focused 17-test green run is included in the 111-test full-suite result, not an additional coverage total. No original test was changed to obtain green.

## Limits and follow-up

Linux adapter and timestamp fault controls are deterministic on macOS, not a claim of native Linux acceptance. The preceding investigation found no running Docker daemon; no daemon, VM or external service was started. Exact hosted timestamp lag and PID 1149's security attributes remain unavailable from the original logs. If the actual runner owner's executable is unreadable, arming still fails closed. Retaining an identity does not grant Linux signal permission; a signal error remains an error under the existing bounded shutdown path.

No backend/database/S3/worker service profile or GitHub-hosted action was run for this slice. Existing full-profile commands and validators are preserved, but all required hosted checks, all three backend profiles, the whole worker profile and all nine metrics within the shared deadline remain future acceptance work. No runtime improvement is claimed.

Next: review the local commit before any separately authorized publication or CI run. Existing PR #148 remains untouched and unmerged.

Session: `codex://threads/01a1468a-60c3-74a2-baa3-0ad59f19cf34`.
