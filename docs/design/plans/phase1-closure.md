# Phase 1 frontend foundation closure plan

Status: implementation approved by founder “finish phase 1” on 2026-10-09; phase acceptance awaits review. Phase 0 completion confirmed by founder “ok” after the foundation audit on 2026-10-09. This records skeleton acceptance only, not clinical or live-service acceptance.

Baseline: main c88903d. One draft PR from fresh main, intention: complete the frontend foundation requirements for the existing screens. Re-fetch and inspect all PRs before branching.

## Scope and constraints

Inventory every current page, component, form and asset. Close functional accessibility, mobile layout and token reuse defects in existing screens, particularly local review and operations. Preserve established fonts/colors, clinical wording, API contracts, role decisions, reviewer confirmation requirements, hash binding, production exclusion and source evidence. No redesign, new clinical features, AI, AWS/DNS, spend, backend schema or real data. Standard product upload remains the known Phase 1 browser stub; integration belongs to Phase 3/5. No claim that simulated upload saves a report.

## Evidence discovered

- routes.tsx lazy-loads all pages; check-chunks.mjs enforces splitting.
- foundation.spec.ts exercises overview and standard upload at 375 and 1280, keyboard, image and form behavior. auth.spec.ts covers sign-in states and permissions.
- LocalUploadReportPage.test.tsx already has field-error/focus/preservation/busy/axe checks; reuse these rather than duplicate them.
- LocalReviewPage.test.tsx covers confirmation, role refusal, rejection, external-link refusal and hash-bound preview; no complete keyboard/browser/mobile matrix.
- LocalOperationsPage.test.tsx covers no initial writes, explicit confirmation, role refusal and confirmation invalidation. Current screen uses ad hoc controls and generic alert errors.
- ESLint prohibits arbitrary Tailwind values, but that does not prove that every control uses shared component sizes or every form has accessible field errors.

## Implementation order

1. Commit a finite inventory table: route/component/asset/form, existing checks, observed defect, required acceptance check. Include public/error/auth and development-only screens. Distinguish actual defects from untested assertions; do not refactor solely because a status says Partial.
2. Add focused failing tests before fixes: local-review/operations required fields, correct error associations and first-invalid focus, retained input after request refusal, busy/double-submit guard, confirmation remains required, unauthorized actions never make requests. Test only rules those screens actually need; preserve optional fields and lookup-only controls.
3. Repair confirmed defects using existing Button/Input/Label/Checkbox/Alert and design tokens. Split any additional React components discovered by inventory into their own files; avoid unnecessary helper abstraction. Preserve exact report text, whitespace, hashes and reviewer evidence.
4. Extend browser coverage to development-only routes through a separate local dev-server configuration (production builds intentionally exclude them). Use existing fake-IdP authentication. Synthetic intercepted responses may exercise UI states, but label them UI tests; do not represent them as API/storage integration. Reuse existing auth helpers/configuration where possible rather than alter the production-build browser suite.
5. Cover each actionable screen at 375 and 1280: overflow, keyboard reachability/focus, accessible names and errors, appropriate touch sizes, empty/loading/refused/success states. Use axe as one check, plus actual keyboard behavior; neither proves full accessibility alone. Long synthetic source strings must remain readable without page-wide overflow.
6. Inventory image usages. Keep meaningful alternatives on informative images, empty alt on decorative ones with documented reason. Verify responsive sizing/lazy loading where appropriate. Do not lossily re-encode the source-bound PDF preview just to satisfy an image-format slogan; preserve hash/preview association. SVG assets need no forced raster conversion. Fix only measured asset issues and record applicability.
7. Run frontend typecheck/lint/unit/build/chunk checks and existing/new Playwright suites. Keep backend API/storage contracts untouched. Run CI configuration tests if workflow/configuration changes are needed; the eventual draft PR must pass all required CI checks.
8. Defect-inject each new guard/check: remove a label/error link, weaken confirmation or busy guard, introduce overflow, bypass shared control sizing, or expose a dev route in production as appropriate. Record failing test, restore, and verify green; do not commit injected defects.

## Phase 1 acceptance

The inventory accounts for every current screen/form/image/component. Each checklist rule has a passing check or explicit evidence-supported applicability statement for founder acceptance. Existing local safety tests continue passing; standard production routes still exclude local tooling. No cosmetic changes outside required usability. No blanket claim from axe or mocks. Report remaining exceptions honestly and stop for Phase 1 completion confirmation before Phase 2.

## Approval requested

Approve this one-PR Phase 1 closure scope. Any expansion into actual product upload, live services, clinical interpretation, or AI requires a different plan. If inventory uncovers a material architecture change, stop and propose it rather than add it silently.

## Delivery

Draft PR plus updated phase tracker and inventory; report Implemented / Risks / Controls / Tests / Follow-ups. No merge without founder instruction.

AGENTS.md rule: yes
