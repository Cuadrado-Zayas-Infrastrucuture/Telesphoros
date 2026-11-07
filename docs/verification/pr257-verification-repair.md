# PR 257 verification repair
Date: 2026-11-02

This continues [patient result decisions](patient-result-decisions.md) on PR #257. It supersedes that note's unresolved local Git/process failures without changing the report-reader implementation boundary. The reader engine remains absent. AI generated the corrections and performed the diagnosis; no new clinical validation or deployment is claimed.

## Reproductions and corrections

- The infrastructure log from the preceding verification reproduced `spawnSync git EPIPE`. Inspection found NUL-delimited paths sent to `git init`, which does not consume stdin. The new session's baseline and ten bounded repeats did not reproduce this intermittent race. Only `check-ignore --stdin` now receives the paths; all error/status and negative-control assertions remain. The focused 23 checks and complete 285 infrastructure checks pass.
- Unchanged subprocess tests reproduced two failed process-cleanup assertions (15 passed). Only PIDs recorded by those fresh fixtures were inspected: their descendants were terminated zombies, adopted by this container's non-reaping PID 1 (`tail -f /dev/null`). A temporary Linux `PR_SET_CHILD_SUBREAPER` runner outside the repository supplies init reaping. All 17 cases and the full root workspace test command pass beneath it. No production termination behavior or assertion changed.
- The standard browser tier reproduced navigation behind native modal panels. Tests now close report/history/settings panels before navigating, enter ordinary attachment through chat, and use browser Back for compatibility upload recovery. Existing roles, stale-upload, recovery-key, retry and storage assertions remain.
- Once report lists had populated, partial accessible-name selectors matched both `Past reports` and `Past reports list`. The existing section visibility and accessibility assertions now select the exact section name.
- Local preview tests reproduced reminder requests during an interaction that promises to stay local (44 passes, 2 failures). The sidebar's existing `/local-*` exclusion for live lists now also applies to the follow-up inbox. The no-network assertion is unchanged; the local-to-chat navigation test additionally checks that reminders become available again in the normal workspace.
- Appearance/foundation tests reproduced pending browser fetches after a real API 503. Network inspection confirmed received headers and a complete direct API response. Follow-up and decision helpers now release unread rejected response bodies before raising their existing errors; the unchanged network-idle cases pass. The decision retry/conflict tier also passes.
- The existing touch-target guard found the chat's programmatic file input exposed a 1px box. The input is now fully hidden behind the existing labelled attachment button. The unchanged 44px guard passes.
- Hosted run `41499379480` failed three database assertions: the append-only inventory omitted `patient_followups`, and its new medication foreign key caused plain medication TRUNCATE to fail before reaching the append-only trigger. The inventory now covers follow-ups, and the medication guard test uses `TRUNCATE ... CASCADE`, matching the existing ledger tests. Its exact `23000` assertion remains. No migration, privilege or constraint was altered.

## Completed checks

| Check | Result |
| --- | --- |
| Workspace typecheck, lint/format and production build | Passed after the source corrections |
| Production chunk/foundation checks | Passed: 101.4 kB gzip entry, 13 lazy pages, 154 components; preview and AI SDK excluded |
| Root workspace tests | Passed under the temporary subreaper; backend 2,077 passed / 471 skipped; frontend 694 + 55 branding/preview checks passed |
| Frontend recheck after the final response-body/file-picker changes | 694 tests across 62 files and 55 branding/preview checks passed |
| Infrastructure | 285 passed |
| CI configuration | 217 passed |
| Agent workflow references and guards | Passed, including 5 tests |
| Real PostgreSQL catalog, medication, decision/follow-up HTTP and browser orchestration | Five suites / 91 tests passed; includes 37 decision HTTP, 19 follow-up HTTP and all 10 decision browser cases |
| Standard browser regression | 229 distinct cases passed across the full run and corrected-case rerun; 5 intentional viewport skips |
| Local preview browser regression | 46 distinct cases passed across the full run and correction rerun; 4-case rerun also covers returning to chat with reminders available |
| Owned-storage navigation browser tier | 2 passed |
| Final sidebar correction | 56 sidebar/chat unit cases, frontend lint, typecheck/build, formatting and chunk/foundation checks passed |

Other root workspace tiers passed: scripts 47, password notifier 10, CPIC schema 48, jobs 20, fake IDP 7, shared types 137, AI service 347, worker 151 and SMART pilot 188. The 471 backend skips include opt-in service and absent-engine cases; they remain skips. The preceding milestone's 38-case product rehearsal remains documented separately.

The standard browser run finished with 221 passes, 8 failures and 5 viewport skips. All eight failures were the reader's navigation behind the upload panel and the ambiguous report-region selectors described above; all eight passed in a fresh targeted rerun after correction. This is not presented as a single uninterrupted green full-suite run. Accessibility assertions remain active in light/dark themes, mobile/desktop and attachment states. The generated mobile report-details screenshot was visually checked for readable content and a reachable close control; incidental landing captures were restored rather than committed.

The real PostgreSQL/browser tier retains the disclosed stand-in reader, recorded text, synthetic knowledge, test identity provider and in-memory test object storage from the preceding note. The standard browser suite uses the actual memory API, fake identity provider and Moto S3 emulator; deliberate browser transport faults remain for recovery tests. These do not verify real report extraction or a clinical engine.

The local preview run had 44 passes and the two network-boundary failures described above; both corrected cases and both local-to-chat navigation cases then passed. The subsequent owned-storage navigation run passed both cases. Each Playwright-managed identity/API/storage/frontend stack shut down after its run; the dedicated PostgreSQL cluster was stopped with its own `pg_ctl` after the database checks.

Hosted verification of the correction commit remains pending. Hosted `verify`, `secret-scan` and `image` passed on the preceding commit. Its PostgreSQL/S3 job finished with 4,074 passed, 3 failed and 2 skipped; its three failures are the same inventory/TRUNCATE cases diagnosed above. Its memory service job had 3,405 passed, 3 failed and 671 skipped. These results do not substitute for checks on the correction commit. PR #257 was marked ready because this repository skips CI for drafts. Nothing was merged or deployed. Local logs are `/tmp/telesphoros-investor-tools/pr257-*.log`.
