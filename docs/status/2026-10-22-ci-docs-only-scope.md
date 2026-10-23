# CI: documentation-only changes skip the heavy jobs (local)

Date: 2026-10-22

A pull request or push that changes only `docs/**/*.md` or a root `*.md` no longer runs the service path, `browser`, `image` or `terraform`. `verify` still runs and reports, but only its two guards that read documentation (`pnpm test:infra`, `pnpm test:ci-config`), after the install that `test:infra` needs. `terraform` and `terraform-lint` are also skipped when nothing under `infrastructure/`, `.tflint.hcl` or `.github/` changed. All six required checks still report: a job skipped by a job-level condition reports success, and the filtering is inside the workflow, not in `on:`, so no check is left pending. The rule is narrow on purpose (markdown under `knowledge/` is read by a backend test; `docs/` also holds JSON and PNG files) and `scope.test.mjs` fails if a new test starts reading documentation.

Verified locally: `pnpm test:ci-config` with new controls on real git history (renames, deletions, mixed changes, a checkout that is not the named test merge, a push with no usable previous tip), six on-disk mutations that each turned the guard red and were restored, and the two guards run in a clean export, which showed that `test:infra` cannot run without the install (so the install stays). Not verified: GitHub's own treatment of the skipped required checks in this repository's ruleset, because hosted CI is stopped until the minutes reset.

Local only: nothing is pushed.
