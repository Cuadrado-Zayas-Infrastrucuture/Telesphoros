# FD-7a mandatory CI coverage — local verification

## Scope and acceptance

The local `feat/fd7a-required-ci` candidate starts at main `c12c47a` and assembles
the approved standalone delivery `aec888e` with mandatory coverage in the existing
required `terraform` job. This record describes local macOS arm64 verification;
no hosted acceptance or live AWS enforcement is claimed.

The required job keeps its name, Ubuntu runner, 15-minute cap, read-only
permissions and full action SHA pins. Each root requires recursive fmt checking,
backend-disabled/read-only-lock initialization, validation and every mocked plan.
The standalone source guard and policy suite are mandatory. Node remains
22.22.0, Terraform 1.16.5, pnpm 10.28.0 and AWS provider 6.68.0 with the reviewed
locks. Each root initializes independently. The policy suite invokes one fresh,
private native mocked-plan producer and retains stdout, stderr and native exit
metadata; the workflow retains those files even after failure.

## Native results

| Check | Passed | Failed | Selected skips |
| --- | ---: | ---: | ---: |
| Standalone policy/mutation cases | 171 | 0 | 0 |
| Standalone source guards | 21 | 0 | 0 |
| Standalone native mocked plans | 22 | 0 | 0 |
| Existing infrastructure guards | 96 | 0 | 0 |
| Existing main-root native mocked plans | 33 | 0 | 0 |
| Full CI configuration controls | 131 | 0 | 0 |
| Focused workflow controls (included in 131) | 59 | 0 | 0 |
| Workspace controls | 8 | 0 | 0 |
| Workflow checker controls | 4 | 0 | 0 |

Both roots passed fmt, backend-disabled init with read-only locks and validate.
Actionlint 1.7.12 passed. Full native stdout/stderr and producer exits were saved
before filtering. The 171 cases retain 145 original requests, all 16 promoted
requests and ten unchanged mutation challenges. The separate native fixture
reported one passing plan, no failed/errored/skipped runs and native exit zero.

The CI controls reject missing/duplicate producers, wrong order/working
directory, conditional/optional execution, swallowed native exits, filtering,
cached-producer overrides, changed runtime pins and lost artifact retention.
Actual commands propagate native exit 17. Six actual policy-entry controls refuse
native failure, skipped/missing/duplicate plans, malformed JSON and seeded stale
output, preserving their native receipts and intended refusal reasons.

## Failures retained and corrected

The intentional initial missing-coverage control failed against the original
workflow. Initial expanded harness controls exposed selection of an earlier
setup action and inherited `NODE_TEST_CONTEXT` suppressing a nested launch;
controls now select the Terraform job and clear that inherited test context.
Those failures remain in the external evidence; the final controls all pass.

The first existing infrastructure run failed because the fresh checkout lacked
`zod`. A frozen offline workspace install from the existing cache resolved the
setup gap. The entire existing suite then passed 96/96; no guard was weakened,
filtered or skipped. This assembly did not change the dependency lockfile.

## Preservation

All ten standalone root files match `aec888e` byte-for-byte, including resources,
variables, outputs, both native fixtures, provider lock, source guard, evaluator,
original/promoted policy requests and all mutation challenges. The existing main
root, provider lock and application code are unchanged. Only the required
Terraform job changes in the workflow; every other workflow byte is preserved,
including service profiles, joining/evidence gates, cleanup/cancellation and the
single shared 30-minute budget. All six required check names remain.

Before/after comparison matches 11 protected checkouts and 14,963 tracked-file
hashes, including all refs, statuses and source bytes. Preserved heads include
both earlier FD-7a candidates `40700c7` and `3243fef`, F06 `fe4251b`, F07 `a4ca244`,
combined `86fb1ca`, delivery `aec888e`, catalog `b345e7c`, session candidates
`955f4c7` / `ad3f83d`, published docs `eccd668` and lifecycle repair `2b7d27c`.

## Main drift and remaining gates

While this local assembly was verified, PR #152 advanced main to `efb6103`.
Read-only comparison shows only additions to `docs/STATUS.md` and
`docs/ops/ci-cd.md`; application and CI bytes have not drifted. This candidate
retains its approved `c12c47a` base. Before later publication, integrate the new
main documentation without dropping either historical record and recheck the
resulting exact head. No automatic rebase or expansion of scope was performed.

Independent assembled-candidate review and explicitly authorized hosted Linux CI
remain required. No push, PR, merge or deployment has occurred for FD-7a. Backend
activation/main wiring remains separate. AWS IAM/KMS/SCP permissions, live lock
contention, state/version recovery, custody and spending gates are untested;
mocked plans and the policy subset evaluator do not establish them. Credentials
were removed, metadata disabled, backends off, and no apply or cloud operation
was used. The separate lifecycle repair remains outside this candidate.


## Local reconciliation with current main — 2026-10-17

The previous sections retain the first assembly's evidence and pending-drift
record verbatim. The founder subsequently authorized local reconciliation.
`feat/fd7a-required-ci-main` now starts directly at freshly fetched main
`efb6103ab7732f489b17d0e35c5fbff6bf073ef1`; `2fbc1b3` remains recoverable in its
unchanged branch/checkout. Fresh main/PR inspection found only the known two
documentation changes. No unrelated implementation repair was needed.

The newest main runbook is byte-identical, and every latest-main status line,
every prior candidate status line and all prior FD-7a documentation are preserved
in order with their original bytes. Dated reconciliation additions distinguish
this acceptance from the earlier candidate and historical hosted runs. All ten
standalone files, original/promoted probes, native fixtures, resource policies,
provider locks and CI implementation match `2fbc1b3` / `aec888e` exactly.

Fresh verification of the reconciled candidate passed all 171 policy/mutation
cases, 21 source guards, 22 standalone mocked plans, 33 main-root mocked plans,
96 existing infrastructure tests, 59 focused controls and 131 full CI controls,
8 workspace and 4 workflow controls, with zero selected skips. Both roots passed
fmt, backend-disabled/read-only-lock init and validate; actionlint, whitespace
and the exact staged-diff secret scan passed. The source used pinned Node22.22.0,
pnpm10.28.0, Terraform1.16.5 and AWS6.68.0, isolated provider data, disabled cloud
credentials and no backend activation. One fresh native policy producer and all
12 refusal invocations from the two final control runs are retained separately
from the first assembly's failed setup/harness evidence.

Final protection comparison preserves the prior 11 checkouts/14,963 tracked-file
hashes, plus `2fbc1b3`'s 1,402 files: 12 checkouts/16,365 hashes with refs, statuses
and source bytes unchanged. The implementation remains local and unpublished;
independent review, explicitly authorized exact-head hosted Linux CI and every
live backend/permission/locking/recovery/custody/spending gate remain open.


## Producer-fault probes made permanent — 2026-10-17

The founder approved promoting the four independent review probes from `cf532cd`.
`feat/fd7a-producer-faults` starts directly from freshly fetched main `efb6103` and
carries the reviewed candidate unchanged except for the existing refusal harness
and these dated documentation additions. The source candidate remains untouched.

The shared harness now also invokes the actual policy entry point with a missing
executable (`ENOENT`), a producer terminated by `SIGTERM`, successful but empty
output, and a timed-out producer (`ETIMEDOUT`). Each case requires child exit 1,
exact native status/signal/error, fresh producer evidence, exact arguments and
complete output retention before assertions. The earlier six refusal cases stay
in place. The timeout case loads a 150 ms deadline only in its nested test process;
the policy producer's real 120-second deadline remains unchanged. This exercises
the timeout refusal path, not the real deadline's wall-clock duration.

Fresh local verification passed 63 focused controls and 135 full CI controls
(the full count includes the focused count), with all ten refusal cases in both
runs. The 20 refusal receipts were inspected separately from the six baseline
receipts. All 171 policy/mutation cases (145 original + 16 promoted + 10 mutation
checks), 21 state guards, 22 standalone mocked plans, 33 main-root mocked plans,
96 existing infrastructure tests, 8 workspace and 4 workflow controls passed;
zero selected skips. Both roots passed fmt, backend-disabled/read-only-lock init
and validate; actionlint passed. Pinned Node 22.22.0, pnpm 10.28.0, Terraform 1.16.5
and locked AWS 6.68.0 were used with isolated provider data, disabled credentials
and no cloud operations. All 1,402 source files stayed fixed during verification;
only documentation was added afterward.

All ten standalone files, resource policies, locks, native fixtures, workflow
commands and service profiles are byte-identical to `cf532cd`; all earlier main
and candidate documentation remains in order. Complete native stdout/stderr,
exits, fault receipts, source hashes and final preservation proof are retained
outside the repository in `work/fd7a-fault-promotion-verification/`. The final
external report binds the local commit to this evidence.

These results are local macOS acceptance. Independent final-candidate review,
separately authorized publication and exact-head hosted Linux CI remain open.
Backend activation and live IAM/KMS/SCP, lock contention, recovery, custody and
spending gates remain separate. No backend wiring, hosted CI dispatch/rerun,
push, PR, merge, apply or deployment occurred.


## Delivery reconciliation on current main — 2026-10-17

The founder authorized a local reconciliation preserving the four producer-fault
controls, README clarification and merged worker fix #154, without push or merge.
`feat/fd7a-delivery-reconciled` starts directly from main
`95c6ead8708bac217c4a26071adecf9c71a066e5`. The FD-7a payload comes from preserved
`79b727ff494742e816c73021830ffa7b68049d30`; the clarified README comes from
published `bb14e08ccff0020bab7cecf089ad17a704b77965`. All four published status,
runbook, verification and session files are exact prefixes of their local-source
counterparts; those complete local records remain prefixes of this candidate.

The standalone implementation and workflow retain the reviewed bytes. The four
permanent faults remain missing executable (`ENOENT`), terminated producer
(`SIGTERM`), native successful empty output, and timeout (`ETIMEDOUT`), alongside
the earlier six refusals. Native stdout/stderr/exit receipts are retained before
assertions, fresh producer identity and exact arguments are required, and the
timeout override stays nested-child-only. Worker code is byte-identical to main;
the separate early-stop and signal-synchronization experiment is excluded.

Verification for this new candidate is recorded separately from historical
results above. Full native outputs/exits, fresh producer and refusal receipts,
source/history accounting and protected snapshots are retained outside the repo
under the 2026-10-17 reconciliation evidence. The external completion report
binds the final local commit and tree to the tested source hashes and lists all
completed checks, failures and limits. No previous head's hosted results are
treated as acceptance of this candidate.

This remains local-only. Required exact-head hosted Linux CI is a later authorized
delivery gate; main-backend activation, live IAM/KMS/SCP, lock contention,
state/version recovery, custody and spending acceptance remain separate. No
push, PR creation, hosted dispatch/rerun, merge, cloud apply or deployment is
included. Every protected checkout and its refs/source bytes remain preserved.


## Native-error refusal regression — 2026-10-17

Review of `b58ebc5` found that a producer with native status 0, signal null and
`ETIMEDOUT` could satisfy the policy entry. A finite synthetic producer reproduced
that false acceptance with all 171 cases passing; a healthy producer using the
same synthetic output also passed. This saved output is deliberate fault input,
not fresh Terraform acceptance evidence.

The correction requires status 0, signal null and an absent native error after
writing complete stdout/stderr/exit receipts. The eleventh permanent refusal
handles SIGTERM with exit 0 after a child-only 500 ms deadline, self-exits after
3 seconds if no signal arrives, and requires the exact `ETIMEDOUT` producer-failure
reason. Its minimal output contains a passing summary: a later missing-plan
assertion must not satisfy the control. It failed against the old guard and passes
with the correction. The paired complete-plan probe now rejects the timeout while
the healthy producer still passes. All ten earlier refusals, including the four
permanent native faults, are retained; the original timeout remains 150 ms and
the real producer deadline remains 120 seconds.

Fresh local acceptance reruns the full FD-7a matrix against fixed source hashes,
including a new real mocked Terraform policy producer, independently accounted
145 original / 16 promoted / 10 mutation cases, all eleven refusal receipts in
both CI-control suites and exact equivalence for the original four faults.
The external `fd7a-native-error-fix` completion report binds the final local commit
and tree to the actual counts, red/green evidence, native exits, scope and
protected-checkout snapshots. Earlier dated results remain historical. README
clarification, worker #154, workflow, resource policies, locks and fixtures stay
unchanged. This is local macOS verification; publication, exact-head hosted Linux
CI and live backend/IAM/KMS/locking/recovery/custody/spending gates remain open.
No services, cloud operations, CI reruns, push or merge are included.
