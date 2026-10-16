# Telesphoros sidebar and chat layout — verified local change

October 15, 2026. Repository: Telesphoros-Remastered. Baseline `23f17c4a0b377077b207f2c9bdfc2e744348ff46`; local branch `feat/dashboard-guided-workflows`. Verification recorded before feature-branch delivery. No PR, deployment, cloud changes or real records.

## Implemented

- Signed-in operational pages use a left sidebar for Chat preview, Reports, Upload report and Overview. Links follow the existing role, storage-mode and development boundaries. On mobile, navigation collapses behind a labeled menu button. The public landing retains its existing header and artwork.
- The existing development chat route is a wide central workspace. Prompt Kit message, composer, suggestion, source, feedback, tool and loading adaptations remain in use with the existing `@ai-sdk/react` `useChat` hook. The composer is compact and secondary questions use a menu. At 1280×800, the conversation is wider than 800px.
- Report browsing has its own full-width surface. Selecting a row opens its authorized metadata/download controls in a native modal drawer. Closing returns focus to that row. Skeleton loading and page-local filename/storage filtering are retained.
- The chat's bundled report context, synthetic source image, explanation basis, local attachment controls and response provenance live in an evidence drawer. Source image preview is a nested native dialog. Opening, closing and reopening drawers preserve the conversation. A child dialog cannot dismiss its parent, and stale close events cannot dismiss a newly reopened drawer.
- Earlier approved improvements remain: optional three-step upload, per-step validation, progress, retained native file input, and a review summary before the existing upload operation.

## Prompt Kit provenance

The requested https://www.prompt-kit.com/ai-sdk page returned HTTP 403. The official [Prompt Kit source repository](https://github.com/ibelick/prompt-kit) and existing adapters were inspected instead. Vendored adaptations retain their MIT notice and original pinned source reference (`5a9496635cc0e1bf7679fe2a9e35d9b36b99c08a`). No dependency or SDK version was changed. The previously stale adapter README was corrected to describe the installed `useChat` integration.

## Risks and controls

The chat is still a local development demonstration with fixed synthetic responses. It produces no clinical recommendations, uses no selected patient/report, sends no model request and writes no chat persistence. Report metadata and the bundled example remain separate.

Backend code, schemas, clinical gates, route guards, roles, upload/recovery behavior, live transport, SDK hook, dependency manifests and lockfile are unchanged. Existing fonts, colors and original artwork are preserved; only layout-size tokens were added. Branding gates and their policy were not weakened.

Native modal behavior makes the background inert; explicit keyboard wrapping, Escape handling, focus return, nested-dialog event isolation and queued-close protection are browser-tested. The React 19 button ref type is exposed for the mobile navigation toggle. Synthetic-only and clinical-use boundaries stay visible.

Filename search applies to the loaded report page only, with explicit scope, counts, reset and empty-state copy.

## Verification before the Prompt Kit conversation refinement

| Check | Result |
|---|---|
| Frontend Vitest | 307 passed, 26 files |
| Branding rejection suite | 24 passed |
| Lint, typecheck, production build | Passed |
| Chunk/foundation checks | Passed; 116.2 kB gzip entry, below 150 kB budget; development chat/AI SDK transport excluded from production assets/maps |
| Development browser profile | 18 passed across 375×812 and 1280×800: chat, drawers, nested image, local attachment metadata, no requests/persistence, stop/reset/retry, feedback, scrolling, reduced motion, 200% text, report paging/filtering and skeleton loading |
| Owned-storage production-style browser profile | 20 passed: report drawers, rapid reopen, pagination, filtering, skeleton/error recovery, guided upload and role restrictions |
| Standard production-style browser profile | 80 passed: sign-in/out, token handling, access controls, keyboard/touch targets, upload, server refusal, retries, lost replies, navigation retirement and reload/cancel recovery |
| Visual review | Desktop, mobile, output and drawer screenshots inspected; open drawer screenshots captured at viewport size to represent fixed modal positioning accurately |
| Patch | Cumulative patch checked against the recorded baseline |

The unit count reflects replacing obsolete inline-assistant presentation tests with the approved separate chat/drawer flow; SDK lifecycle and permission coverage remain. Browser tests use CI-pinned Node 22.22.0, the fake identity provider, the real in-memory API and Moto 5.2.4 over loopback S3. No real AWS resources are used. Database/worker tiers, remote CI, hosted production and clinical acceptance were not run or claimed; no backend/schema change is included.

The real loop caught a composer that consumed too much vertical space, native Tab wrapping, nested close propagation and a queued-close/reopen race that was visible in the production build. Those were repaired; final relevant checks passed. Mobile tests now open the sidebar menu before using its links rather than reaching through collapsed navigation.

## Delivery and follow-ups

Source is retained on the feature branch; commit and push were requested after local review. The cumulative patch includes the earlier questionnaire/filter improvements plus this sidebar revision and tests/documentation, against the recorded baseline. No PR or deployment was requested.

Proposed AGENTS.md convention: “Child dialog closure must not dismiss its parent drawer; test rapid close/reopen and focus return in a real browser.” The global instructions file was not edited.

## Prompt Kit conversation refinement

- Approved scope: UI-only reasoning summary, thinking bar, visible System notice and source access. No changes to model prompts, response fixtures, SDK hook, transport, backend or production data.
- Reused pinned MIT Prompt Kit adapters after inspecting the official reasoning, thinking-bar, system-message and source source files; documentation endpoints returned 403. No packages added.
- Completed exchanges retain independently collapsed explanation summaries. Known sample questions and unmatched fallback questions have distinct, truthful selection descriptions. No model thoughts or clinical evidence are fabricated.
- Source shortcut opens the existing evidence drawer with the fixture source expanded; toolbar opens general context. Source remains explicitly interface copy, not a clinical citation.
- Thinking bar shows three explicitly simulated phases from the existing SDK lifecycle; Stop restores composer focus and removes pending UI. System is a visible UI notice only.
- Final automated checks: frontend typecheck/lint/build, 309 Vitest cases in 26 files, 24 brand rejection checks, chunk budget and foundation guards all passed. Production entry 116.2 kB gzip; DEV preview and synthetic transport excluded from production.
- Browser checks via Codex browser: 1280px desktop and 375px mobile; native explanation expansion/collapse, source drawer, Escape and source-trigger focus restoration; mobile Stop with no late completed response; no horizontal overflow in inspected states. Screenshots saved under outputs/prompt-kit in the task workspace.
- Existing full browser regression suite was not rerun for this refinement; its changed staged-label and source-opening expectations were updated. No backend or production acceptance claimed.
