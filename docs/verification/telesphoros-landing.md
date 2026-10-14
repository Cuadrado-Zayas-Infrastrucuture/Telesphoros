# Telesphoros landing verification

Date: 2026-10-13. Local implementation on `feat/telesphoros-landing`, based on `origin/main` at `98cd931` after verifying the previous dashboard PR was merged. [Approved scope](../design/plans/telesphoros-landing.md).

## Commit delivery check (2026-10-14)

Founder requested commit and push and approved the delivery plan. The staged snapshot contains the landing page, its shared mascot component, assets, tests and evidence only. Earlier dashboard contrast and AI-welcome integration edits remain uncommitted in the working tree. A separate checkout of the exact staged snapshot passed 264 frontend tests, lint, TypeScript/production build and chunk/foundation/DEV-exclusion checks. Logs: `/private/tmp/landing-commit-unit.log`, `/private/tmp/landing-commit-lint.log`, `/private/tmp/landing-commit-build.log`. The 28 browser checks above were run before delivery against the reviewed landing implementation; they were not repeated for staging alone.

No Vercel deployment performed: no local Vercel project/configuration, GitHub deployment records or repository webhooks were found. Latest-main checks are GitHub Actions CI only. The checked-in workflow runs on pull requests and pushes to main, with no deployment step; this feature-branch push alone does not run that workflow. No PR, merge or deployment was requested. Reconcile newer main before PR delivery, as recorded below.

## Latest: approved Inter typography (2026-10-14)

Applied self-hosted Inter to landing headings, body, navigation and footer using a landing-specific token. The existing Poppins wordmark and all other routes retain their typography. Inter is an OFL-licensed alternative selected by the founder, not OpenAI Sans. Copy, colors, layout rules, original DNA and mascot bytes, permissions and development boundaries are unchanged.

Verification: 264 frontend tests and all 28 landing/foundation browser cases passed; lint, TypeScript/production build, e2e build, chunk/foundation/DEV-exclusion guards and whitespace checks passed. Browser checks at 375px and 1280px verify font loading, the Poppins wordmark, typography after navigation, workflow interactions, accessibility, 200% text, overflow and role-aware actions. Full-page and hero screenshots were refreshed and visually inspected: [desktop](../design/previews/landing-desktop-1280.png), [mobile](../design/previews/landing-mobile-375.png). The entry bundle remains 113.5 KiB gzip against a 150 KiB budget.

Logs: `/private/tmp/landing-inter-unit.log`, `/private/tmp/landing-inter-lint.log`, `/private/tmp/landing-inter-build.log`, `/private/tmp/landing-inter-e2e-build.log`, `/private/tmp/landing-inter-browser.log`. No backend, model, dashboard, cloud or deployment change; no commit or PR requested. Current-main reconciliation and artwork publication-rights limitations recorded below still apply.

## Product purpose and copy (2026-10-14)

Applied the founder-approved headline “A clearer view of your PGx reports,” Upload / Check / Find workflow, shorter supporting copy and closing invitation. Removed the repetitive outcome block without changing interaction behavior. Added the explicitly approved direction “Working toward less trial-and-error prescribing,” with a visible current-capability statement and a prescribing FAQ. Expanded feature descriptions to existing patient selection, supported formats, storage-mode patient filtering, file status, permitted downloads and the separate fixed-response assistant.

The purpose paragraph cites the [NHGRI fact sheet](https://www.genome.gov/about-genomics/educational-resources/fact-sheets/pharmacogenomics). This is background context only; no prescribing result, clinical efficacy, live interpretation or compliance claim is made. Sources and call sites were rechecked against `UploadReportPage`, `ReportsPage`, `ReportDetails`, route/role gates, `ownedStorageApi` and `syntheticChatTransport`.

Verification: 264 frontend tests passed; lint, TypeScript/production build, production chunk/foundation/DEV-exclusion checks and e2e build passed. All 28 focused landing/foundation browser cases passed at 375px/1280px, including all workflow scenes, contrast, keyboard use, 200% text, no horizontal overflow, sign-in and reader denial. Desktop/mobile full-page, hero, purpose and workflow screenshots were refreshed and visually inspected. Original DNA and mascot hashes match the values below; DNA remains static. The shared assistant interface was not edited or retested in this copy-only iteration.

Logs: `/private/tmp/landing-copy-unit.log`, `/private/tmp/landing-copy-lint.log`, `/private/tmp/landing-copy-build.log`, `/private/tmp/landing-copy-e2e-build.log`, `/private/tmp/landing-copy-browser.log`. Evidence: [desktop](../design/previews/landing-desktop-1280.png), [mobile](../design/previews/landing-mobile-375.png), [desktop purpose](../design/previews/landing-purpose-desktop-1280.png), [mobile purpose](../design/previews/landing-purpose-mobile-375.png).

Remote state was fetched before editing: `origin/main` is now `1b4fb4e`, with PRs #94–96 merged. This existing uncommitted landing branch remains based on `98cd931`; no authorization code was changed or merged into the preview. These tests describe this local branch, not the newer backend. Reconcile with current main and rerun applicable checks before PR delivery. No commit, push, deployment or clinical/model change in this task.

## Previous: workflow redesign (2026-10-13)

Founder approved making the workflow more appealing and informative. Replaced the table-first illustration with three selectable scenes: **Add a report → Verify its upload → Inspect file details**. Each combines a dark teal purpose/outcome panel with a larger light product example. Mobile stacks the panels; native step buttons, next/restart controls, format selection, incomplete-upload comparison and record selection are keyboard accessible. No timers or animation were added.

Copy was checked against `UploadReportPage` (existing patient selection, VCF/JSON, clinician/admin access), `ReportDetails`, and the owned-storage home. The third scene explicitly describes the separate storage workspace. Verification remains storage-only, never clinical interpretation. The demo is component state only, and browser tests verify no API requests or file input during interaction.

Results: 264 unit tests passed; lint, TypeScript/build, chunk/foundation/DEV-exclusion guards passed; 28 production browser cases passed at 375px/1280px. All three scenes pass axe A/AA and enlarged-text/no-overflow checks. Keyboard Enter/Space, state preservation, forward/restart navigation, sign-in, reader denial and unchanged static DNA were verified. Logs: `/private/tmp/workflow-tests.log`, `/private/tmp/workflow-build.log`, `/private/tmp/workflow-browser.log`.

Evidence: [desktop workflow](../design/previews/workflow-desktop-1280.png), [mobile workflow](../design/previews/workflow-mobile-375.png), [desktop incomplete comparison](../design/previews/workflow-verify-desktop-1280.png), [mobile incomplete comparison](../design/previews/workflow-verify-mobile-375.png). Full-page landing screenshots were refreshed too.

Scope: landing workflow component/copy/styles and corresponding browser assertions only. Hero, original artwork, mascot, dashboard, auth, backend, SDK and development-only gates remain unchanged. Superseded illustration CSS was removed. No commit, push or deployment. Follow-up: founder visual review.

## Previous: approved research sketch implemented (2026-10-13)

This section supersedes the earlier landing composition and screenshot descriptions below.

- Replaced the generic hero/capability/audience blocks with the approved concrete headline, report-list/file-details walkthrough, two capability rows, four native FAQs, and companion-mascot closing. Poppins and shared teal tokens are retained. Shared header keeps real account navigation; the landing footer now accurately describes software in development. Other footer routes are unchanged.
- Two fictional records switch a React state-only detail pane. Native buttons support Enter/Space, expose selection through aria-pressed, and identify the politely announced detail region. Browser checks verify selection makes no API request. No file input, backend call, upload or download exists in this illustration.
- Actual call-site mapping: standard `UploadReportPage` accepts `.vcf,.json`, owned mode also accepts `.pdf`; `HomePage` retains its owned-storage branch; `WRITER_ROLES` remains clinician/admin. Local interpretation still requires DEV and loopback. Landing actions retain the existing sign-in/upload destinations and role branches.
- Exact asset SHA-256 values remain unchanged: DNA `2e4c1dcfdd618cf63c9b5699108695b2665c43867efde375b4ba26d380a0c8c8`; mascot `1dfa2dc62d132b9898e86e3493e47fc2e47f66eb22337ce0c1748c88b49e0c8b`. DNA uses static -38° rotation from the approved sketch, proportional scaling, screen blend and opacity. No asset editing or animation.
- Repair loop caught a missing headline space in the DOM test, missing explicit image loading attributes, and a shrinking capability-number column. Fixed each; no checks were disabled. A 320px visual check also led to a compact landing-only header: sign-in beside the logo, section navigation below. CSS is restricted to the landing subtree or explicit landing header class; the shared mascot stylesheet and assistant layout remain unchanged.

| Check | Latest result |
| --- | --- |
| Frontend unit suite | 264 passed / 23 files |
| ESLint, TypeScript, production build | Passed |
| Chunk/foundation/exclusion guards | Passed; entry 113.5 KiB gzip, eight lazy page chunks; synthetic AI/SDK excluded from production |
| Landing + foundation browser suite | 28 passed at 375px and 1280px |
| DEV mascot/welcome regression | 2 passed at 375px and 1280px; synthetic response/reset and centered AI mascot retained |
| Accessibility and interaction | No axe A/AA violations in checked states; 200% text, no overflow, keyboard FAQ/record selection, 44px controls, sign-in and reader denial passed |
| Narrowest visual check | 320px document width equals viewport width; headline fits and DNA remains static |
| Artwork | Loaded original PNGs; byte hashes unchanged; static DNA and unchanged mascot appearance |

Browser tests used installed Chrome, Node 22, fake identity and an in-memory Moto fixture on loopback. Initial harness launches failed because sandbox ports were blocked, Moto was not on PATH, Node 24 had a Unicode mismatch, and the default Playwright browser revision was absent. Resolved by using the installed runtime/browser/fixture; application controls were unchanged. Logs: `/private/tmp/landing-unit-final.log`, `/private/tmp/landing-build.log`, `/private/tmp/landing-browser-final.log`, `/private/tmp/landing-mascot-final.log`. Existing non-failing hydration/color warnings remain.

Desktop and mobile evidence: [desktop](../design/previews/landing-desktop-1280.png), [mobile](../design/previews/landing-mobile-375.png). No backend, schema, permission, model/prompt, dashboard, deployment or cloud changes in this iteration. No commit or PR requested. Existing artwork publication-rights limitation below remains unchanged. Follow-up: founder review of the local preview.

## Earlier implementation history

## Implemented

Standard home now contains section navigation, a teal gradient hero with static diagonal particle DNA, Poppins typography, a fictional report-workspace illustration, capability/workflow/audience sections, native disclosure FAQ and closing account actions. The existing product logo and company footer remain distinct. A regular-weight Poppins asset is self-hosted under the existing OFL license.

## Iterations and repairs

1. Built the page around the current report-storage capabilities and existing role rules. Inspected the desktop hero and mobile page rather than relying only on a build.
2. Mobile review showed the DNA was too far outside the viewport. Moved it inward and adjusted opacity; the image remains static and decorative. Landing navigation focus could hide the shared header, so only the landing route now retains the top of the page while focusing main content.
3. Full-page review found the mobile workflow numbers could wrap. Prevented the number column from shrinking. Verified final desktop/mobile screenshots and enlarged-text layout.

Initial verification also caught a table-driven test parameter shape, an unsupported ARIA attribute on `picture`, exact-text selectors spanning a line break/decorative plus, and an old test expecting a lazy informative DNA image. These were corrected: empty image alt conveys its new decorative purpose; the above-fold image loads eagerly with responsive AVIF/WebP and reserved dimensions. No check was disabled or timeout increased.

## Controls

- Owned-storage home is preserved. Standard landing links use existing clinician/admin roles and destinations; readers receive no upload action. Signing in grants no extra permissions.
- Illustration contains fictional report labels only; no patient inputs, fetched records or operational controls.
- No backend, schema, authorization, report processing, retention, model, prompt or SDK behavior changes. Production exclusion guards still reject DEV interpretation/SDK assets.
- No deployment, AWS operation, real patient data, commit, push or PR in this task.

## Results

| Check | Result |
| --- | --- |
| Frontend tests | 264 passed across 23 files, including role actions and owned-storage home |
| Frontend lint | Passed |
| TypeScript and production build | Passed |
| Chunk/foundation guards | Passed; 113.5 KiB gzip entry / 150 KiB budget; eight lazy page chunks |
| Standard browser suite | 64 passed at 375px and 1280px |
| DEV browser suite | 26 passed, including synthetic AI interactions and local-only controls |
| Accessibility and layout | No axe WCAG 2.0/2.1 A/AA violations in tested states; keyboard FAQ, skip link, 44px targets, 200% text and no horizontal overflow passed |
| DNA and navigation (initial flat-helix pass) | Image loaded in modern format, transform diagonal, no animation; anchors, sign-in, return-home logo and reader restrictions passed. Superseded artwork is documented below. |
| Whitespace | `git diff --check` passed |

This is local UI verification, not accessibility certification or clinical validation. Browser checks used local fake identity, API and synthetic storage fixtures. Database/clinical acceptance and remote CI were not rerun for this presentation-only change; no model evaluation applies.

Existing non-failing Vite hydration and terminal color warnings remain. Unrelated screenshots regenerated by DEV regression were restored to their previous tracked bytes. The local loopback preview was restarted after test fixtures exited for founder review.

## Evidence

- [Desktop full page](../design/previews/landing-desktop-1280.png), [desktop hero](../design/previews/landing-hero-desktop-1280.png)
- [Mobile full page](../design/previews/landing-mobile-375.png), [mobile hero](../design/previews/landing-hero-mobile-375.png)
- Local logs: `/private/tmp/telesphoros-landing-tests.log`, `/private/tmp/telesphoros-landing-lint.log`, `/private/tmp/telesphoros-landing-build.log`, `/private/tmp/telesphoros-landing-browser.log`.

Follow-up: founder visual review. Any clinical launch or live AI integration remains a separately approved task.

## Correction: preserve the supplied molecule

The founder rejected the flat helix substitution. Restored the exact 474 × 843 particle PNG embedded in the earlier static social-card design, including its watermark. The source SHA-256 matches the original embedded bytes; see `apps/frontend/src/assets/particle-dna-provenance.md`. Removed grayscale/invert filters and retained the original -42-degree orientation and screen blend. Adjusted only proportional scale, positioning and opacity for desktop/mobile. The source is served as the original PNG, so the previous AVIF/WebP asset check now asserts this source and absence of a filter instead.

No page copy, typography, permissions or workflow changes. The asset remains a watermarked concept reference; publication rights have not been established. Focused verification is recorded in `/private/tmp/telesphoros-dna-correction.log`.

Correction results: lint, TypeScript/production build and chunk/exclusion guards passed; 28 focused landing/foundation browser cases passed at 375px and 1280px, including contrast, 200% text, keyboard use and role-aware actions. Desktop and mobile screenshots were refreshed and visually inspected. Earlier complete regression counts above describe the preceding page implementation; no clinical or AI behavior changed in this correction.
