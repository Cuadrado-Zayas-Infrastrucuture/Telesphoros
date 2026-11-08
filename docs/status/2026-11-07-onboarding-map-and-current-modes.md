# The onboarding map names what exists, and the capability page says what runs now

Date: 2026-11-07

A read-only onboarding audit of main `859e964a` found that the pages a newcomer reads first described an older repository. Documentation only; no code, test, Terraform or setting changed.

What changed:

- `README.md` and `CONTRIBUTING.md`: the layout table now lists `apps/worker`, `packages/jobs` and `packages/smart-pilot`, calls `apps/ai-service` a library and `packages/fhir-utils` an empty placeholder, names the three files in `sidecars/report-lookup`, and says `sidecars/report-reader` is optional and private and not in the public checkout. A "what the public checkout can and cannot run" table was added, and `pnpm check:workflows` joined both check lists.
- `docs/product-capabilities.md`: a "Current supported modes" section, read from the routes, build flags and server configuration, now leads. The 2026-10-14 table is kept as a dated baseline with its known out-of-date rows named (`/reports` has been mounted in every build since 2026-10-27).
- `docs/architecture.md`: the stale "local F07" sentence (main declares GET-only reports CORS) and the "worker not accepted in a hosted environment" sentence were corrected to match `docs/ops/environments.md`.
- `docs/database.md`: a verification matrix gives, for each test command, its prerequisite services, the boundary it proves, the notice it prints when it skips and whether it runs on a pull request or nightly.
- `docs/ops/team-access.md`: the release scripts are in `scripts/staging/release/` (spec 027 PR 3a and 3b), so the row that called them private was rewritten around what is still open: a first full run with them. A new-hire checklist was added.
- `docs/ops/ci-cd.md`: a reading order at the top separates the sections that describe CI now from the dated records.

Not done, and why: landing READMEs for `tests/`, `data/`, `ml/`, `knowledge/` and `specs/` wait for the moves in ADR 0001, which writes each top-level README in the pull request that makes its folder final. `docs/ops/jobs.md` still says the worker Terraform was "not applied" in its opening line while its own later line records the synthetic staging apply; that is for a separate change.
