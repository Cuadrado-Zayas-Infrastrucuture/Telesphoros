# Prototype PR verification repair
Date: 2026-11-02

Continued PR #257 by reproducing local verification failures and enabling hosted checks. The repository skips CI for draft PRs; marking the existing PR ready runs the unchanged required workflow, without merging or deploying.

The Git-ignore test helper supplied path input even to `git init`, which does not read stdin. Only `check-ignore --stdin` now receives that input. Error/status checks and every negative-control assertion remain intact. The complete infrastructure suite passed all 285 checks after the correction.

Both subprocess cleanup assertions failed locally because terminated grandchildren were zombies adopted by this container's PID 1 (`tail -f /dev/null`). A temporary Linux subreaper outside the repository supplied the missing reaping behavior. The unchanged 17 subprocess cases and complete workspace tests then passed, including 2,077 backend tests and 694 frontend tests; the default backend's 471 service/engine/opt-in skips remain skips. No reader implementation, process termination logic or test assertion was changed.

Browser navigation also needs to follow the current chat-panel UI: close a modal panel before using the sidebar, enter normal attachment through chat, and use browser Back to reopen an interrupted compatibility upload. Existing authorization, recovery-key, persistence, accessibility and download assertions are retained.

Rejected follow-up/decision responses now release their unread bodies before raising the existing errors. Real HTTP 503 responses had kept browser requests pending and failed the unchanged network-idle accessibility checks; those checks passed after cleanup. The chat file picker is fully hidden behind its existing labelled attachment button, eliminating its stray 1px box.

Hosted database failures also identified the missing `patient_followups` append-only classification. The inventory now includes it, and the medication truncation test uses CASCADE to get past the new foreign-key restriction and reach the exact append-only refusal. The corrected PostgreSQL tier passed 91 tests across five suites, including the unchanged catalog protections, medication protections, decision/follow-up APIs and all 10 decision browser cases. No applied migration or constraint was changed.

The local demonstration's no-network checks also caught live reminder reads in the preview sidebar. Follow-ups now respect the sidebar's existing local-preview boundary, and become available when returning to normal chat. The unchanged no-network assertions pass.

Across full runs and targeted correction reruns, 229 standard browser cases and 46 local preview cases passed, with five intentional viewport skips; both owned-storage navigation cases passed. Final sidebar/chat verification passed 56 unit cases, lint, typecheck/build and chunk/foundation guards. The dedicated PostgreSQL cluster and browser-managed services were stopped.

AI generated these corrections and performed the local diagnosis. Hosted checks on the correction commit remain pending. [Plan](../design/plans/pr257-verification-repair.md) and [verification with exact run counts and limitations](../verification/pr257-verification-repair.md).
