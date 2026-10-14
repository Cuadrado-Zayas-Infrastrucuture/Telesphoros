# Compact Reports workspace

Approved and verified locally on 14 October 2026, branch `feat/dashboard-brand-rules`, based on fetched main `523fbbd`. Prepared for the requested draft PR; no merge or deployment.

## Implemented

Primary report details sit above the assistant. Patient, record status, upload verification and permitted Download remain accessible; file type, provenance and the existing detailed verification explanation are under Technical details. The default assistant has one heading, a smaller unchanged mascot beside a short welcome, one starter question and an accessible Questions menu for the other fixed questions. The prompt is outside the transcript's scrolling region. Context, synthetic attachments, simulation controls and the full preview link remain available through a disclosure.

The report table and transcript adapt to screen height. Mobile keeps a shorter report list and the existing selected-report/back interaction. Shortened toolbar labels keep Explain, Questions and Reset on one row even at 320px. Questions open above that row, inside the panel's width; Escape returns focus, and selection returns focus to the prompt. A floating compact Latest message control does not add a row or displace the composer.

## Evidence

| Normal text size, page scroll at zero | Reports bottom | Primary details bottom | Entire composer bottom | Viewport height |
|---|---:|---:|---:|---:|
| 1280px desktop | 791.6px | 448.6px | 791.6px | 800px |
| 1440px desktop | 871.6px | 448.6px | 823.6px | 900px |

The 1280px composer kept the same position before/after a fixed response with a selected report. Source expansion and local feedback also left its document position unchanged in the mobile check. No horizontal overflow at 320/390/1280/1440px. Visible controls at 390px were at least 44px high; Explain, Questions and Reset measured 44px high and shared a row at 320px. Native question-menu keyboard dismissal, source disclosure, local feedback, reset and returning from selected details were exercised in the actual local UI.

Delivery recheck: 273 frontend tests, 24 brand guard tests and 186 SMART pilot tests passed. Frontend and SMART lint/type-check/build both passed with branding guards running; frontend production exclusion checks passed. The final relevant suite was rerun after compact-label changes: Reports and standalone preview, 44 tests. Lint, type-check/build, production chunk/exclusion and whitespace checks passed. Tests include embedded role-aware download/attachment controls, retained verification explanation, question-menu focus and unchanged synthetic behavior. Browser review used the existing actual loopback API/fake IdP and synthetic metadata; no DOM data injection.

An initial lint failure identified a keyboard handler on the noninteractive details container. The handler moved to its summary and question buttons; lint then passed. The first fit measurement placed the composer footer below 800px; spacing/heading/list-height changes brought the whole composer into view. The initial compact mobile toolbar wrapped Reset; shorter visual labels fixed it without reducing touch targets or changing submitted question labels.

## Controls and limitations

Palette, font families, logo/DNA/mascot asset bytes, button fills and semantic colors are unchanged. A 28px compact Reports title size is defined centrally in the token sheet. The compact layout is only applied when the local development assistant is available. Response fixtures, transport, hook, auth/roles, backend and shared Button implementation have no diff from the branch base. Production checks confirm no assistant component, AI SDK or synthetic transport is shipped. No selected report/patient data is sent into the assistant; no live interpretation or CPIC mapping is added.

Fit measurements cover the default collapsed tools/technical fields and ordinary synthetic filenames. Opening extra details, enlarging text, long identifiers or short viewports may require page scrolling; controls are not clipped to force a fit. Full automated browser suites, OS text scaling and screen-reader testing were not rerun. Actual metadata fixtures have incomplete uploads; uploaded/downloadable states were checked by role-aware unit tests, not a new real file transfer. Clinical use is not validated.

## Review

Local preview: `http://127.0.0.1:4192/reports`. Reviewer artifacts: [desktop](../design/previews/reports-compact-desktop-1280.png), [mobile](../design/previews/reports-compact-mobile-390.png) and [fit measurements](../design/previews/reports-compact-fit.json). Additional local captures and the earlier research/proposal remain under `outputs/dashboard-brand-review` outside this worktree.

The existing frontend AGENTS accessibility line now requires verifying primary report details and composer together at 1280×800. Full repository CI remains required before merging the draft PR. Production, clinical permissions and workflow holds remain unchanged.
