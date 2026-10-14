# Prompt Kit interpretation preview — verification

Date: 2026-10-13. Draft PR delivery on `feat/reports-loading-interactions`. Verification ran on base `0e7e8d8`; delivery rebases onto `ae4fd97`, whose only intervening changes are #92 planning documents. Existing dashboard refinements are included in this slice. The founder authorized commit, push and draft PR creation; no deployment or production acceptance is claimed.

## Implemented

The report detail panel offers **Open PGx explanation preview** only in Vite development on 127.0.0.1. The authenticated `/local-interpretation` page pairs fictional report context with Prompt Kit input/message primitives, the existing teal/seafoam theme, shared Poppins/system typography and button styles. Mobile stacks the panels and composer actions. The conversation is bounded to six exchanges and the input to 400 characters; presets add exchanges, and Reset clears history, feedback and attachment metadata. Enter sends, Shift+Enter inserts a newline, IME composition does not send.

Three hand-authored fixture answers and an unknown-question fallback simulate loading, stop, retry, reset and failure. Source disclosures identify the actual UI fixture; they do not invent CPIC citations. There is no actual PGx result, genotype, phenotype or recommendation. Prompt Kit upstream revision and MIT notice are preserved in `apps/frontend/src/components/prompt-kit/`. The approved SDK continuation pins `@ai-sdk/react` 4.0.142 and `ai` 7.0.139. Real `useChat` now manages the conversation through an in-memory synthetic transport; no provider/model transport is configured. The [SDK review](../design/prompt-kit-sdk-review.md) records current official OpenAI/Vercel documentation, the future integration recommendation and requested component coverage.

## Controls

- Existing ProtectedRoute authenticates the page just like the other DEV previews. Readers can explore fixtures without gaining upload/download/review permissions.
- The link has no query string or router state. The preview accepts no patient/report props and has no API/file access.
- No fetch, model endpoint, credentials, telemetry, storage writes or clinical prompt in the preview controls. The scoped file selector/drop zone checks existing writer roles, synthetic confirmation and busy state; it retains only filename/size and never reads bytes. The image viewer displays a separate bundled fixture only. Input is transient React state, rendered as text. Leaving the page cancels pending work; reopening starts fresh.
- DEV route gate, loopback render/transport gates and production asset/source-map guards; production deep link returns the not-found page.
- Fixed response provenance remains separate from structured context. Missing evidence is explicit; no clinical processing is enabled.

## Checks and results

| Check | Result |
| --- | --- |
| Frontend unit/integration | 258 passed, 22 files |
| Frontend lint | Passed |
| Production build including TypeScript | Passed |
| Chunk/foundation guards | Passed; eight production page chunks, 113.3 KiB gzip entry / 150 KiB budget |
| Production browser suite | 58 passed (375px / 1280px), including missing preview route |
| DEV browser suite | 26 passed (375px / 1280px), including eight preview cases |
| Browser preview interactions | Loading stages/shimmer, cancellation, sources, simulated failure/retry, reset, bounded history, reader role, attachment validation/drop, image dialog/zoom/Escape/focus, per-message feedback and latest-message scrolling |
| No requests from prompt interactions | Observed zero fetch/XHR requests after preview initialization; unit checks also assert no fetch or storage writes |
| Accessibility | No axe WCAG A/AA violations in exercised states; keyboard/focus, reduced-motion skeleton, 200% text and no horizontal overflow passed |
| Production negative control | Injected fixture marker into generated JS; guard correctly failed. A synthetic SDK module in a generated source map was also rejected. Restored original bytes; guards passed |
| Whitespace | `git diff --check` passed |

This is UI verification, not clinical validation or accessibility certification. Backend database/storage tiers and the separate owned-storage suite were not rerun for this UI-only addition; standard real fake-IdP/API browser fixtures were used. No model/prompt/decoding change, so no model eval was applicable. Remote CI has not run.

## Evaluate and repair

Initial tests caught ambiguous test selectors (app-level route status and similarly named sample controls); selectors were scoped to the explanation region and exact textbox. Code review found a potential native form default after the Stop button becomes Send; cancelling now prevents the click default before state changes. Unit and real-browser cancellation controls pass. A final mobile 200% text test identified heading and long preview-control overflow; wrapping and bounded widths fixed both. Manual image review prompted a stacked mobile composer to avoid a narrow helper-text column. All final suites above ran after the repairs.

## Evidence and access

- Desktop: `docs/design/previews/pgx-kit-expanded-empty-desktop-1280.png` (entry), `pgx-kit-expanded-desktop-1280.png` (response), `pgx-kit-activity-desktop-1280.png` (stages)
- Mobile: `docs/design/previews/pgx-kit-expanded-mobile-375.png`; image/feedback/loading counterparts are alongside it
- Local logs: `/private/tmp/telesphoros-sdk-tests.log`, `telesphoros-sdk-lint.log`, `telesphoros-sdk-build.log`, `telesphoros-sdk-browser.log`.
- In the configured local DEV app on 127.0.0.1, sign in, open a report in Reports and choose the preview link. The authenticated `/local-interpretation` route also works without owned storage; its back link then returns to Overview.
- Browser fixtures exited; test ports 3010, 4010, 4173 and 5557 had no listeners after verification.

Follow-up: founder visual review; any real clinical evidence binding or model integration needs a separate approved scope and evaluations. Required remote CI must pass before any separately authorized merge.

## Further founder-requested iteration

Three further visual passes were completed after the initial preview:

| Pass | Finding / change | Verification |
| --- | --- | --- |
| 1: richer workspace | Restored the original shield/Rx in the shared header and welcome view. Split source/attachment controls from a bounded multi-exchange conversation; adapted the requested Prompt Kit patterns. | Desktop/mobile screenshots reviewed. Corrected a prohibited ARIA label by giving the stable conversation-end target a group role. |
| 2: density and scrolling | Reduced empty space, shortened composer, improved placeholder contrast, stacked mobile composer actions. A content ResizeObserver now keeps the latest content in view only while following the bottom, including disclosure expansion. | Real-browser controls prove scroll-up position is retained and Latest message restores the bottom and keyboard focus; local feedback/attachments and native image dialog passed. |
| 3: source inspection | Added image zoom and a bounded keyboard-scrollable viewport, keeping the close control accessible. | Final 58 standard + 26 DEV browser tests and 247 frontend tests passed after the final source edits. Desktop/mobile image and activity states inspected. |

Intermediate screenshots were preserved outside the repo under `outputs/prompt-kit-iterations/pass-1` and `pass-2`; final evidence is in the repo preview directory. The paused-clock loading test initially stalled axe's own timers; its final version checks the loading state while paused, cancels the simulation, resumes the clock and then audits accessibility. No timeout was increased and no assertion was disabled. JSDOM schedules its own disclosure events, so the unmount unit test asserts that the active staged-response timer is explicitly cancelled rather than assuming all DOM timers belong to the component.

The shared logo is the original raster asset copied without recoloring; its provenance and provisional size guidance are documented beside it. The company square/DNA footer symbol remains distinct. No new vector master or revised brand-spec document is claimed. Final browser runs explicitly unset inherited AWS profile selectors so fixture static credentials and local endpoints are unambiguous; no cloud operation was requested. Existing non-failing Vite hydration and chunk warnings remain.

## Vercel AI SDK continuation

Replaced manual message/timer state on the page with `useSyntheticChat` and the SDK's `sendMessage`, status, `regenerate` and awaited `stop`. The transport alone owns synthetic stage timers; it checks DEV/loopback on direct calls and returns no reconnectable session. Fixed response copy is unchanged; no prompt/model eval applies.

Tests exercise actual SDK parsing/lifecycle (the hook is not mocked), transient progress chunks, repeated simulated failures with one retained user question, reset during SDK preparation, stopping later work while preserving completed feedback, abort at each stage, already-aborted signals, reader cancellation, cleanup on unmount and direct transport host/build refusal. Existing browser tests again observed zero prompt fetch/XHR requests. The final browser run passed 58 production +26 DEV cases; desktop response and mobile activity screenshots were inspected.

Repairs: narrowed the SDK's generic `body` type before reading the simulation flag; awaited asynchronous SDK transitions in unit tests; fixed test-only TypeScript annotations/selectors. Stop/reset wait for queued SDK updates before removing messages. Installation uses the workspace's existing pnpm store; no global configuration changed. Existing JSX-a11y/ESLint peer and hydration warnings remain nonblocking. No live provider, remote CI, deployment or clinical acceptance is claimed.
