# Phase 1 frontend foundation closure

Baseline main c88903d, 2026-10-09. Scope: existing frontend foundation; synthetic data only. Plan: ../design/plans/phase1-closure.md. Status: local verification passed; draft PR/CI and founder phase acceptance pending.

## Finite inventory

| Screen | Forms/actions and states | Evidence |
| --- | --- | --- |
| HomePage | Public overview; navigation and optimized helix | routes.test, production foundation browser suite |
| UploadReportPage | Required fields, invalid/error/busy/success, keyboard | upload unit and production browser suites; browser-only submission stub |
| SignInPage | Sign-in action, callback failure return | auth unit/browser suites |
| AuthCallbackPage | Signing-in, account not configured, callback refusal | auth browser suite |
| SignedOutPage | Provider session ended, sign-in navigation | auth browser suite and public-page axe unit test |
| ForbiddenPage | Role refusal; no form displayed | auth browser suite; now separately lazy-loaded |
| NotFoundPage | Unknown route and return navigation | public-page unit/production browser axe check |
| LocalUploadReportPage | Required fields, invalid/error/busy/success | existing unit form/axe checks and local dev browser layout |
| LocalReviewPage | Upload, capture lookup, PDF/text comparison, accept/reject, evaluation | role/hash/link refusal unit tests; field errors/focus, source text, long values and comparison browser checks |
| LocalOperationsPage | History, correction/supersession, disputes/decisions/impact, admin ledger action | confirmation/role unit tests; local browser validation/refusal, selected history/correction, scroll region checks |
| RouteError / AppLayout | Friendly error fallback, skip/focus, busy navigation, header/account/footer | route wiring, shared foundation/auth browser checks |

Rendered component inventory: structural guard scans production .tsx outside tests; one named component per file, matching file/component names. Contexts and hooks are separate; Form.tsx only re-exports compatibility names. This guard is structural and does not prove semantics. UI/shared controls inherit existing tokens; no palette/font redesign.

Asset inventory: helix.png is converted by existing vite-imagetools to responsive AVIF/WebP with dimensions and lazy loading. local-D01.svg is the existing lossless source-bound 612x792 preview, shown only for its registered PDF hash, now dimensioned and lazy-loaded; no re-encoding or source/hash change. These are the only image render sites. SVG is already a vector representation, so forcing AVIF/WebP would lose fidelity. No downloadable fonts; existing system-font stack retained.

## Changes and guard coverage

- Replaced local ad hoc controls with existing Button/Input/Checkbox/NativeSelect and a token-based Textarea.
- Removed nested main landmarks; containing AppLayout supplies the one main/skip target.
- Local fields have explicit label IDs, aria-invalid, linked error text and first-invalid focus; existing schemas validate operations before requests. Inputs retained after refusal.
- Busy states disable submissions; a synchronous ref guard rejects same-turn overlapping actions. Reviewer confirmation, hash preview association and role refusals remain.
- Source text stays byte-identical in DOM; visual wrapping never modifies it. Long output/history stays in named keyboard-focusable scroll regions.
- Form components split into files without changing their context/error behavior.
- New structure guard checks image attributes, names/file ownership, all seven production page chunks and absence of all three Local pages from production manifest. Existing entry budget remains 150 kB gzip.
- Dev-screen browser suite uses Vite development mode and real fake-IdP login/API me authentication. Record responses intercepted with synthetic data: UI evidence only, not storage/clinical integration. Existing production-build suite remains separate. Both run under the existing CI browser command.

## Limits and retained shortcuts

Standard upload intentionally still simulates submission in the browser. Phase 1 requires a working sample form/shell, not a saved clinical report; real product upload belongs to Phase 3/5 and is not declared complete here. Local tools remain dev-only; no production permission added. Browser and axe checks cover the listed states, not every possible device, assistive technology or external-provider failure. A source hash and matching preview do not establish clinical correctness. Runtime production/live deployment and clinical approval remain open.

## Verification

- Frontend unit suite: 117 tests pass across 13 files, including retained values, invalid field focus/association, confirmation/role refusal, and same-turn duplicate requests.
- Production-build browser suite: 46 pass; development-only browser suite: 16 pass. Both run at 375 and 1280 widths. Local record fixtures are mocked/intercepted, authentication uses the fake identity provider.
- Root lint/typecheck and CI configuration guards pass; final frontend lint/typecheck/build/chunk guards pass. Entry: 141.0 kB gzip against unchanged 150 kB budget; seven lazy production pages, three local pages excluded, 42 named components checked.
- Twelve deliberate defects rejected: two components in one file, component-name drift, missing alt, missing image dimensions, eager production page, local page leak, missing capture error association, comparison bypass, weakened dispute busy state, skipped local browser suite, and each screen's same-turn request guard removed. All files restored; unit/structural controls green. See phase1-defects.json.
- Runtime: macOS arm64, browser test Node 22.22.0 / Unicode 16.0, installed Chromium build 1234. Host Node 24.14.0 correctly refused backend startup due to Unicode 17.0; no backend guard weakened. Local loopback services required sandbox escalation.
- Native desktop macOS select popup ArrowDown behavior differed from Linux/mobile; the test now uses keyboard typeahead with a value assertion. No mouse selection or test skip.
- Baseline evidence: the original before run had three failing tests (invalid capture, invalid upload, dispute fields), restored/fixed runs passed. Twelve negative controls cover the new mechanisms; no clinical-quality inference is made.
- No AWS calls, Terraform apply, DNS, real-provider mail, live clinical data or production deployment occurred. Required PR CI remains to be read before final delivery.

AGENTS.md rule: yes
