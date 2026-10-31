# Tasks: A chat-first home with a feature panel, in every build

- [x] T001 Tests first: unit tests for the home routing (CH-1) and the panel items per role (CH-2), and browser tests on a production-mode build (`vite build`, served on a non-`127.0.0.1` host name) for CH-1 to CH-7. Each fails on `main`.
- [x] T002 `WorkspacePage` at `/workspace` (lazy, production): the chat column reuses the prompt-kit components and the workspace's attach, patient and confirmation pieces, without `useSyntheticChat` (D1, D3, D5).
- [x] T003 Upload in the conversation through `submitReport`; the report's status word and "Check status" from `listReports` (CH-3); the not-available note for a typed question (CH-4); the file-type rules (D4, CH-6).
- [x] T004 `WorkspaceSidebar` grows into the feature panel: New chat, Past reports, Patients, Upload report, All reports, Usage, Settings, account (D2, D6, CH-2). In Patients, an "Add patient" control for writer roles through `createPatient` with its request id (D2a, CH-9).
- [x] T005 Home routing: `signedInHome` and `landingAfterSignIn` send writer and clinical roles to `/workspace` outside the local preview; administrators without a clinical role keep `/usage` (D6).
- [x] T006 Guards: `check-chunks.mjs` `PAGES`, `check-foundation`, and any route list the new page must join (CH-8).
- [x] T007 Full local loop (every `ci.yml` step that runs locally), both browser configs, gitleaks. (2026-10-30: every local ci.yml step; frontend 563, worker 241, backend 3222 / 3753 / 3773 passed of 3774; e2e 205 + 46 + 2 passed, 5 skipped; e2e:storage 33; ci-config 207; infra 157; gitleaks clean. One tier-3 suite was killed by the parallel spec 025 backend build's tests on the shared local cluster and passed alone, 6 of 6; fixture-lifecycle tests 6 and 8 fail on main too.)
- [x] T008 Screenshots at 390, 768 and 1280 px, light and dark, of a production-mode build, sent to the founder before any commit. (2026-10-30: six sent; "Looks right, commit".)
