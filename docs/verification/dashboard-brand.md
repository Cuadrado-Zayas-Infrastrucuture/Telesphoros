# Dashboard brand identity and build rules

Branding verification snapshot from 14 October 2026, before the final compact layout. Branch `feat/dashboard-brand-rules`, based on fetched main `523fbbd`. The separate landing-polish checkout and prior dashboard checkout were preserved. See [the compact dashboard verification](dashboard-compact-assistant.md) for the final interface, latest checks and delivery evidence; statements about no commit/push below describe the original verification pass.

## Implemented

- Centralized the existing Inter and Poppins font faces in the shared token sheet. Inter is the content font; report/upload/development-preview headings use a compact Inter hierarchy. Poppins remains the product wordmark. Landing font declarations moved centrally without changing its layout or artwork.
- Restored the previously approved reports text colors: #173E47 for primary text, #36515A for secondary text. Button fills and semantic/status colors remain their original values. Neutral report statuses explicitly retain #225560.
- Restored the approved centered assistant welcome using the original MascotWelcome component and unchanged transparent mascot. Sample copy, response fixtures, SDK transport and clinical boundaries were not changed.
- Added the strict frontend AGENTS.md rules and shared branding documentation.
- Added a reviewed policy pinning palette/font tokens, minimum control size, original artwork/font hashes, required brand references and key contrast pairs.
- Added a buildStart branding plugin to both UI Vite configurations. Normal builds and direct Vite builds run it, including alternate modes. Existing workspace/CI builds use those configurations.

## Brand violations rejected

Token/color drift, lighter dashboard text, changed button/status fills, altered or missing artwork/fonts, replacement brand references, page-local font loading, external CSS/font imports, literal colors outside the token sheet, unapproved inline font/color/background/border overrides, foreign palette and arbitrary Tailwind utilities, insufficient key contrast, undersized shared control tokens, missing dashboard font rules, DNA/mascot animation/filter declarations, and removed build-gate registrations.

The policy is not silently regenerated when a check fails. An intentional rebrand requires explicit founder approval, a reviewed policy update and browser evidence. This is a finite source/build contract; it does not replace visual or accessibility review.

## Tests

| Check | Result |
|---|---|
| Frontend unit suite | 264 passed across 23 files after typography/mascot changes, including existing roles, report loading, upload behavior and development-route restrictions. |
| Brand mutation suite | 24 rejection/baseline tests passed. Mutations are in-memory copies; original artwork and source remain intact. |
| Frontend build/typecheck | Passed with branding guard running. |
| SMART pilot build | Passed with the same branding guard running. |
| Lint / whitespace | Passed after repairing one unnecessary regex escape. |
| Production chunks/foundation | Passed; eight lazy page chunks, entry 113.6 kB gzip vs 150 kB budget. Development interpretation route, AI SDK and synthetic transport remain excluded. |
| Actual negative builds | Direct frontend and SMART Vite commands both returned exit 1 for an owned temporary stylesheet containing an unapproved color. The new probe was removed in finally; no existing file was overwritten. |
| Real local browser | Actual API + fake IdP, not an injected dashboard mock. Reviewer could read metadata without upload/attachment controls; clinician upload action opened the existing form. |
| Responsive review | Report list/detail at 320, 390, 768 and 1440px: no horizontal page overflow. Original header logo measured 64px at 320/390. Visible controls measured at least 44px at 390. |
| Focus and filters | Patient filter showed two matching rows; Back restored focus to the originating report on mobile. |
| Computed identity | Body/headings Inter; wordmark Poppins; report title rgb(23,62,71), neutral status rgb(34,85,96). |
| Assistant | Original mascot visible, fixed synthetic answer rendered, reset restored welcome. Reviewer attachment controls unavailable; no live model added. |

The first brand mutation run exposed a font-declaration parser gap; the test failed, the parser was repaired, and the rejection suite passed. A later parser check initially confused a Button class variant with an inline style; parsing was narrowed to actual JSX/local style objects, with rejection and acceptance regression tests. The first review-stack configuration used an unsupported object-storage driver; inspection corrected it to the repo's in-memory driver before any data setup. No credentials or error payloads were printed.

## Controls and limitations

No backend, authentication-policy, route-guard, Button component or artwork/font bytes changed. No production service, data, deployment or cloud account was touched. No live LLM prompt/model change; no clinical evaluation claim.

The review API/fake IdP use isolated loopback ports 3022/4022 and in-memory stores with generated synthetic metadata. The frontend preview is http://127.0.0.1:4192/reports. Clinical processing is disabled. The 12 fixtures are metadata-only; they are not presented as verified file uploads. This run does not test PostgreSQL/S3, real clinical processing, clinical validation or production readiness.

Full automated browser suites and OS 200% text/reduced-motion settings were not rerun. Existing browser expectations were updated for Inter and the approved centered mascot, while browser checks above were performed through the actual local UI. Source reduced-motion rules remain in place. The existing React Router startup hydration warning is outside this styling slice.

The guard covers the Telesphoros frontend and SMART UI sources/builds. The company page is still a separate local sketch with no build pipeline; apply the shared contract when implementing it in its repository.

## Review artifacts and follow-ups

See `outputs/dashboard-brand-review/` for desktop, mobile list/detail, upload and assistant captures. The local synthetic stack is left running for review; its own SIGINT/SIGTERM shutdown closes only its API/fake IdP and discards its process-memory fixtures.

No commit, push, PR or deployment in this pass. Review the branch before delivery through the normal PR workflow.
