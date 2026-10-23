# CI: a pull request cannot decide its own scope (local)

Date: 2026-10-23

The security audit found that the `changes` job ran `scope.mjs` from the pull request's own checkout, so a change that edited that file could make the required jobs skip, and a skipped job reports success. On a pull request the step now reads the decision code from the base branch (`git show $BASE_SHA:.github/ci/scope.mjs`) and runs that copy. The base id is validated as 40 hex characters first, because an empty id would make `git show` read the index, which is the change's own file; the control for that case caught it during this work. Any failure fails the step, so `changes` fails and every job runs.

Verified locally: `scope.test.mjs` executes the real step in a scratch repository (a change rewriting its own scope is ignored; the same checkout on a push does use the rewritten copy, as the positive control; four invalid bases fail the step with no output), and three on-disk mutations of `ci.yml` each turned the guard red. Not closed, and stated in `docs/ops/ci-cd.md`: a pull request still supplies the workflow file, so only review of `.github/` changes stops an edit to `ci.yml` itself.

Local only until the pull request is opened.
