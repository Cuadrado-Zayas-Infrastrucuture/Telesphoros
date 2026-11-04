# The staging assessment UI (032 S3, PR 3b)

Date: 2026-11-04

The review and assessment of stored structured reports can now be built into the synthetic staging frontend. It is a build-time opt-in, `VITE_SYNTHETIC_ASSESSMENT=true`, off in every ordinary build, and `scripts/staging/publish-frontend.sh --with-synthetic-assessment` is the only way the publish script includes it. Nothing is published by this change, and the API still answers 503 until its own `SYNTHETIC_ASSESSMENT` switch is set (3c), so staging looks the same after this merges.

What changed in the browser: with the flag, the report page opens the independent patient-link review and the saved findings on a deployed host (before, only on `127.0.0.1` in the owned-local build) and adds a **Run synthetic assessment** section, enabled once every saved finding has a decision; it calls the assessment route and shows the stored result with its citation, or the fixed hold wording, labelled synthetic and not approved for clinical use. The patient page's stored results are shown without the decision controls, because decisions on results are not switched on there (reads only). The flag refuses any value but true or false and refuses to be the owned-local build.

Guards: `check-foundation.mjs` fails a build made without the flag if it contains the UI's marker; the publish script checks the marker is in the bundle exactly when the option was given, and refuses a stray `VITE_SYNTHETIC_ASSESSMENT`. A real default build and a real flagged build were made: the marker is absent from the first and present in one chunk of the second, the script accepts the flagged build only with the option, and the default-build guard fails the flagged build.

Verification, Node 22.22.0, pnpm 10.28.0:

- 40 new frontend cases (flag 9, assessment component 21, staging gate and record 7, results list 3) pass; the whole frontend suite passes, 767 tests in 71 files (727 before). Publish script cases: 15 of 15 (13 before, 2 new), inside `test:infra` 302 of 302.
- 16 guard-removal controls (the flag's two refusals, each gate, each readiness rule, the answer check, the role check, the decision controls, and the three publish checks) each turned a suite red; two survived the first pass because one test checked for server text only by exact match and one rule was redundant in practice, and tests were added.
- A real default build and a real flagged build, and the script's own build path with and without the option, behaved as described above.
- `pnpm typecheck`, `pnpm lint`, `pnpm build`, `check:chunks`, `knowledge:verify --production`, `check:workflows`, `test:ci-config` 221, root `pnpm test` 47 with the workspace suites (backend in-process 2133, worker 151), `test:demo-seed`: passed. gitleaks found nothing in the 19 changed files. No backend file changed, so the database tiers were not rerun for this slice.

Not done: a browser walkthrough (the storage browser suite is bound to a disposable local run and cannot start the switch; a manual stack would need a migrated database, seeded personas, the fake identity provider and the switch), the live walkthrough on staging, and everything in 3c (Terraform variable and guard, release of migrations 0068 to 0070 and the image).
