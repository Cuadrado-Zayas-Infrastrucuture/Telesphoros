# Plan: Dark mode

One pull request off `main`, frontend only.

| Area | Change |
| --- | --- |
| `styles/tokens.css` | One `:root[data-theme='dark']` block with the 23 approved dark colours and `color-scheme: dark`. A new `--mark-plate` token: `transparent` in light, seafoam in dark. |
| `scripts/branding-policy.json` | `darkTokens`; the dark hex values added to `allowedColorLiterals`; 12 more contrast pairs (21 in all), which apply to both themes. |
| `scripts/check-branding.mjs` | Reads the dark block apart from the rest, so its values cannot replace the light pins. Requires exactly one dark block, pins each dark value, refuses any other property in it, and runs every contrast pair in both themes. |
| `lib/theme.ts` | Reads and writes the preference (storage failures fall back to the device); `themeFor()` keeps `/` light; `applyTheme()` sets or removes `data-theme` on `<html>`. |
| `theme/ThemeProvider.tsx` | Holds the preference, follows the device live, and applies the theme in a layout effect. Rendered by `AppLayout`, which knows the route. |
| `main.tsx` | Applies the theme before the first render. The CSP allows no inline script, so this is the earliest point. |
| `components/settings/AppearanceChoice.tsx`, `pages/SettingsPage.tsx` | The Appearance section. |
| `styles/index.css`, header, sidebar, footer | `.brand-mark` puts the logo images on the plate. |
| `e2e/helpers.ts` | The axe helper moves here from `foundation.spec.ts`, so the dark tests can share it. |

## Verification

- Checker tests: a changed dark colour, a missing or second dark block, a dark block that sets a size, and poor contrast only in dark are each rejected.
- Unit tests: the storage defaults, blocked storage, the landing rule, the live device listener, and Settings switching and reopening in the saved theme.
- Deliberate breaks: removing the landing rule fails two tests; removing the device listener fails one.
- Browser: axe in the dark theme on Settings, Upload and Reports, on mobile and desktop. Positive control: an injected low-contrast colour makes axe report 14 contrast violations.
- Gates: typecheck, lint, format, build, all frontend tests, `check:chunks`, `check:brand`, `test:brand`, the full e2e suites, and gitleaks.
