# CI: the post-merge run on main reuses a verified tree (local)

Date: 2026-10-22

A push to `main` whose merge commit keeps exactly the tree of the pull-request head that already passed all six required checks no longer re-runs the heavy jobs. A new first job, `changes`, runs `.github/ci/scope.mjs`; `verify`, the service path, `browser`, `terraform` and `terraform-lint` read its `heavy` output, `image` reads `archive`. `secret-scan` always runs. Any doubt, or a failed `changes` job, runs everything. The exact conditions are in `docs/ops/ci-cd.md` ("Skipping work: what is proved").

Verified locally: `pnpm test:ci-config` (186 controls, 9 new, on real git history for every refusal), `actionlint`. Not verified: GitHub's own evaluation of the new conditions and the run-lookup against the live API, because hosted CI is stopped until the October minutes reset; the first hosted runs are the real test. The ruleset file is unchanged.

Local only: nothing is pushed.
