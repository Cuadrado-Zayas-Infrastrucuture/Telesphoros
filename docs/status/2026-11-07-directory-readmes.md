# The worker, the frontend, the AI library, the packages and the scripts each have a landing page

Date: 2026-11-07

A read-only onboarding audit of main `859e964a` found that only `docs/` and `apps/backend` had a README, so browsing `apps/worker`, `apps/frontend`, `apps/ai-service`, `packages/` or `scripts/` gave no entry point, no test command and no boundary. Documentation only; no code, test, Terraform or setting changed.

What was added, one screen each: `apps/worker/README.md` (entry points, the consumers, the boundaries its tests pin), `apps/frontend/README.md` (the request path from `main.tsx` to `shared-types`, the build modes, the test commands), `apps/ai-service/README.md` (says plainly that it is a library with no model, process or deployment, and that nothing imports it today), `packages/README.md` (each package, who imports it, which two are exceptions to the layout rule) and `scripts/README.md` (each folder's purpose and where to start). Each links back to `docs/README.md`, and says what does not belong in the folder.

Not done, and why: landing pages for `tests/`, `data/`, `ml/`, `knowledge/` and `specs/` wait for the moves in ADR 0001, which writes each top-level README in the pull request that makes its folder final. `sidecars/` and `infrastructure/` also have none; the audit's priority list did not include them.
