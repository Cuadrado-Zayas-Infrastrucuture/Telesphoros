---
trigger: glob
globs: "apps/frontend/**/*.ts, apps/frontend/**/*.tsx, apps/frontend/**/*.css"
description: Frontend React/Vite UI, branding tokens, accessibility, Spanish localization, and bundle budget rules.
---

# Frontend & UI Rules

Always follow `apps/frontend/AGENTS.md` and read `docs/design/branding.md` before changing UI layout, styles, or copy.

## Design System & Branding
- Define fonts and literal colors only in `apps/frontend/src/styles/tokens.css`. Never add inline colors/fonts, external font services, foreign palettes, or arbitrary Tailwind color values.
- Use `ProgressiveBlur` for scroll-edge blur only; no glassmorphism, frosted panels, or blurred backdrops (the Vite branding plugin rejects them).
- Keep interactive targets at least 44px high with visible keyboard focus and WCAG A/AA contrast in both light and dark themes.
- Express clinical/operational status as words, not color alone; ensure accessible names start with visible button/link text (WCAG 2.5.3).
- Preserve approved artwork and fonts; never reintroduce retired assets listed in `apps/frontend/scripts/branding-policy.json`.

## Localization & Auth Boundaries
- **No machine-translated Spanish (Spec 050 R8):** never add Spanish UI text unless authored and signed by the founders; untranslated screens remain wholly English.
- Keep access tokens strictly in memory (`AuthProvider`); never persist auth tokens in `localStorage`, `sessionStorage`, cookies, or URLs, and avoid cross-document reloads (`<a href>` / `page.goto`) on signed-in flows.
- Lazy-load heavy data modules (such as `BUNDLED_DRUG_LIST`) so the entry bundle stays within `check:chunks` budgets.

## Verification
Run the exact frontend scripts from repo root:
- `pnpm --filter @telesphoros/frontend typecheck`
- `pnpm --filter @telesphoros/frontend lint`
- `pnpm --filter @telesphoros/frontend test` (branding/secret guards + Vitest)
- `pnpm --filter @telesphoros/frontend build && pnpm --filter @telesphoros/frontend check:chunks`
- Real browser flows via Playwright (`pnpm --filter @telesphoros/frontend e2e` or targeted specs) checking desktop (`1280px`) and mobile (`375px`), keyboard focus, and axe-core accessibility.
