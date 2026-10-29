# Fix: a documentation-only pull request can run the Terraform tripwire again

Date: 2026-10-28

**The problem.** `api-compute.guard.test.mjs` (added in #128) imports the backend's process fault handler and configuration loader, and the loader imports `@telesphoros/shared-types` from its built `dist`. On a documentation-only change `verify` installs dependencies but skips `Production builds`, so `pnpm test:infra` failed with "Cannot find module .../shared-types/dist/index.js". Pull requests since #128 also changed code or `specs/`, which take the full path, so the first pure `docs/` pull request (#144) was the first to fail. The guard's message blamed only the Node version.

**The fix.**

- `verify` builds `@telesphoros/shared-types` before the tripwire, unconditionally, like the install.
- `scope.test.mjs` requires that step in every `verify` run, with a control that makes it conditional and must be reported.
- The guard's two import messages name a missing shared-types build as well as the Node version.

**Checked locally.** With `packages/shared-types/dist` moved aside, `pnpm test:infra` failed as in CI (129 passed, then the import error); after the new step it passed 150 of 150. `pnpm test:ci-config` passed 207 of 207, and failed with the step made conditional.

**Not changed.** The heavy steps, the scope rules for them, and the guards' checks.
