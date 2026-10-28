# Fix: pnpm refuses a Node outside `engines` (local)

Date: 2026-10-28

Follows [the local setup fix](2026-10-28-local-setup-parity.md) (T1), which pinned Node 22.22.0 and left `engine-strict` off.

**Why Node stays at 22.22.0.** Every Node release from 22.22.2 on reports Unicode 17.0 (measured with `process.versions.unicode`: 22.22.2, 22.22.3,
22.23.0 and 22.23.4, the newest 22.x on this date). The lab-report matcher (`apps/backend/src/services/report-adapter/unavailable-matcher.ts`)
and the report lookup policy (`apps/backend/src/services/report-lookup/lookup.ts`) are pinned to Unicode 16.0, which 22.22.0 has. Moving the
pin means re-pinning the matcher deliberately after its conformance tests, which is a separate decision (founder chose to stay, 2026-10-28).

**The fix.**
- `.npmrc` sets `engine-strict=true`, so pnpm refuses to install on a Node outside `engines.node` (`>=22.22.0 <23`) instead of warning.
- jsdom goes from 30.1.3 to 29.1.1 in `apps/frontend` and `packages/smart-pilot`, and a `jsdom: ^29.1.1` override in `pnpm-workspace.yaml`
  holds vitest's optional jsdom peer in the other packages too. jsdom 30 and three of its dependencies (`@asamuzakjp/css-color` 7,
  `@asamuzakjp/dom-selector` 10, `w3c-xmlserializer` 6) declare `^22.22.2 || ^24.15.0 || >=26.0.0`; they were the only lockfile packages that
  reject 22.22.0. The one other hit, `@img/sharp-win32-ia32`, is an optional Windows binary that pnpm skips on macOS and Linux.
- `.github/ci/node-pin.test.mjs` also requires `.npmrc` to set `engine-strict=true` exactly once.

**Not changed.** `.nvmrc`, `engines`, both workflows, the API image and its digest, the matcher, and the CI evidence scripts that pin 22.22.0.

**Checked locally (macOS, pnpm 10.28.0).** On a copy without `node_modules`: `pnpm install --frozen-lockfile` passed on 22.22.0 and was
refused on 24.14.0 ("Expected version: >=22.22.0 <23"); with `.npmrc` removed, 24.14.0 installed with only a warning, so `.npmrc` is what
refuses. `pnpm test:ci-config` 207/207 and `pnpm test:image` 23/23 passed. The pin check went red with `engine-strict=false` and with no
`.npmrc`, then green when restored. On jsdom 29.1.1 the frontend passed 449 tests in 35 files and smart-pilot 188 in 9. `pnpm audit` shows
one low advisory (`deepmerge`, through backend jest), unrelated to this change. Not checked on Linux CI.

**Follow-up.** Dependabot will propose jsdom 30; under `engine-strict` that PR's install fails in CI. An `ignore` entry for jsdom major
updates would stop the noise.
