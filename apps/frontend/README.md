# @telesphoros/frontend

The clinician-facing web app (Vite, React, Tailwind). **Synthetic data only.** Documentation map: [docs/README.md](../../docs/README.md). The UI rules for this folder are in [AGENTS.md](AGENTS.md) and [docs/design/branding.md](../../docs/design/branding.md); read them before changing a screen.

**Where to look, in the order a request travels**

| Step | File or folder |
| --- | --- |
| Start-up: authentication and the router | [`src/main.tsx`](src/main.tsx) |
| Pages, role gates and which routes exist in which build | [`src/app/routes.tsx`](src/app/routes.tsx) |
| A page and the components it uses | [`src/pages/`](src/pages), [`src/components/`](src/components) |
| Browser identity and roles | [`src/auth/`](src/auth), [`src/auth/roles.ts`](src/auth/roles.ts) |
| Build-time modes (`VITE_LOCAL_STORAGE_INTAKE`, `VITE_SYNTHETIC_ASSESSMENT`) | [`src/lib/storageMode.ts`](src/lib/storageMode.ts) |
| API shapes shared with the backend | [`../../packages/shared-types`](../../packages/shared-types) |
| Fonts and literal colors (the only place they may be defined) | [`src/styles/tokens.css`](src/styles/tokens.css) |

Which build shows which screen, and what each mode leaves out: [docs/product-capabilities.md](../../docs/product-capabilities.md). Every page is a lazy import, so each route is its own chunk; `pnpm --filter @telesphoros/frontend check:chunks` enforces it.

**Run and test**

```bash
pnpm --filter @telesphoros/frontend dev           # Vite dev server (adds the development-only local-* routes)
pnpm --filter @telesphoros/frontend test          # branding checks, then vitest
pnpm --filter @telesphoros/frontend typecheck && pnpm --filter @telesphoros/frontend lint
pnpm --filter @telesphoros/frontend build         # type-check, then vite build
pnpm --filter @telesphoros/frontend e2e           # Playwright, against the built API and the fake identity provider
```

`e2e:storage` runs the same journey on real PostgreSQL and needs a disposable database: [docs/ops/local-storage-browser.md](../../docs/ops/local-storage-browser.md). The test commands side by side, with what each skips: [docs/database.md](../../docs/database.md#tests). The other `playwright.*.config.ts` files configure the product-demo, decisions, medication-fence, operations, local and owned-local suites.

**Does not belong here:** server rules (the API authorizes every action again; a hidden button is not a permission), shared API types (`packages/shared-types`), inline fonts or colors, arbitrary Tailwind values.
