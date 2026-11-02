# PR 257 verification repair
Date: 2026-11-02

Continue the requested PR work by diagnosing failing checks before changing code. Preserve the existing test assertions, clinical boundaries and required workflow gates.

Reproduce the Git-ignore failure with real Git. The helper currently sends its NUL-delimited path list to every invocation, including `git init`, which does not consume stdin. Limit the input to `check-ignore --stdin`; retain the temporary repository, status/error checks and all negative controls.

Investigate the subprocess cleanup failures by inspecting only the PIDs recorded by the test fixtures. If killed grandchildren are zombies adopted by a non-reaping container PID 1, rerun the unchanged tests beneath a temporary Linux subreaper to supply the missing environment behavior. Do not change production termination or count a live process as terminated to make the tests pass.

Run the relevant tests and required repository checks, record any remaining failures/skips, and push a bounded correction to the existing PR. Draft PRs skip CI here, so mark the PR ready to obtain hosted evidence without changing the workflow or merging. Investigate any actionable hosted failures; retain the unfinished reader engine as a separate milestone.

The full browser suite also exercises navigation that predates the chat panels. Reproduce these failures, then preserve the original permission, storage, recovery and accessibility assertions while navigating through the current UI: explicitly close modal workspace panels before using the sidebar, use New chat for ordinary report attachment, and keep direct upload-recovery entry checks for the supported compatibility URL. Do not add a separate upload page or restore removed navigation merely to satisfy stale test interactions.

The unchanged appearance/foundation browser cases additionally reproduced a pending follow-up request after a real HTTP 503 from the memory-store API. Network inspection confirmed headers and a complete direct API response, while the browser fetch retained its unread error body. Release rejected follow-up/decision response bodies before raising their existing errors. Keep network-idle and accessibility assertions unchanged; verify the real unavailable-state case and repeat uncertain-save/conflict tests to preserve their semantics.

The live hosted catalog guard found `patient_followups` missing from the append-only record inventory. Add it to that class so all existing forced-RLS, privilege, mutation and deferred-event checks cover it. Its medication foreign key now prevents plain medication TRUNCATE before the append-only trigger; exercise TRUNCATE CASCADE, as the existing generic ledger tests do, retaining the exact `23000` assertion. No migration changes are needed. The browser touch-target guard also identifies the chat file input's 1px screen-reader-only box behind the modal; fully hide that programmatic picker while retaining its labelled 44px attachment button and file-selection behavior.

The complete browser tier also reproduced ambiguous partial-name selectors: `Past reports` matches both the named section and its new scrollable `Past reports list` region. Select the section by its exact accessible name while preserving the existing visibility and accessibility assertions.

The local preview suite reproduced two unexpected follow-up requests during an interaction promised to stay local. The sidebar already excludes live patient/report lists on `/local-*`; apply that same existing boundary to its new follow-up inbox. Preserve the no-network assertion and verify that normal workspace reminders still render.
