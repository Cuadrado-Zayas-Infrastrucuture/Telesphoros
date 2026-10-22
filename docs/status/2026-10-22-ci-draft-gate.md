# CI: draft pull requests run nothing until marked ready (local)

Date: 2026-10-22

A draft pull request no longer starts any hosted job: the `changes` job is skipped for a draft, every job that needs it is skipped with it, and `secret-scan` is skipped because it now runs unless `changes` was skipped. `ready_for_review` is added to the `pull_request` event types so that marking a draft ready starts the real run (a guard pins it). A job that is skipped costs no minutes.

Known gap, written up in `docs/ops/ci-cd.md`: for the few seconds between marking a draft ready and the new run creating its checks, the head carries the draft's skipped checks, which satisfy the required ones. A merge queue would close it, but it is not available to a private repository on the Team plan (PR #249 was closed for that), so the rule is to wait for the checks after marking ready. Verified locally: the CI configuration suite pins the trigger types, the draft condition on `changes`, the secret-scan condition and the failure arms, with mutations that each turn it red. Not verified: GitHub's evaluation of any of this, because hosted CI is stopped until the minutes reset.

Local only: nothing is pushed.
