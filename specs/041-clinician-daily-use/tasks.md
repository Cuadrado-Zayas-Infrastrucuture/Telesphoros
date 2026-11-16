# Tasks: Easier daily use for clinicians

Slices A and D. Front end and the shared ranking; no API, schema, setting or infrastructure change. The plan is the decisions in [spec.md](spec.md).

- [x] T001 Ranking (D1): `rankDrugs` in `packages/shared-types/src/drug-list.ts` breaks ties by single ingredient, then brand presence; fixture test, and bundled-list tests that fail under the old order ("li" offers lisinopril, "am" amlodipine, "me" meloxicam, "se" sertraline) and under a brand-first order ("hydrala", "glimep", "codei", "amlo" offer the single ingredient first).
- [x] T002 Age (D2): `DemographicsValues` uses `exactAge`; test that the table and the banner agree the day before a birthday.
- [x] T003 Date of birth (D3): `onDate()` in `lib/formatWhen.ts`, used by `PatientBanner` and `DemographicsValues`; tests, including a time zone behind UTC.
- [x] T004 Results (D4): processing off reads as a status with no retry in `ResultsList`, and a later successful re-read clears it; unit tests; `product-demo-e2e/patient-results-unavailable.spec.ts` updated. The temporary-failure path keeps its retry (`decision-e2e/patient-decisions.spec.ts`, unchanged).
- [x] T005 Chat home (D5): superseded by D6 (buttons).
- [x] T006 Checks in the sealed sandbox, 2026-11-15: `verify` (typecheck, lint, format, tests, build, chunk check, knowledge, infra, CI config, workflows) exit 0 in 282 s at `42cf22bf`. The first two runs failed and were fixed: Prettier, then `PatientMedications.test.tsx`, which caught a brand-first order putting hydralazine / isosorbide dinitrate above hydralazine (D1 amended). Not run: the browser suites (no browser in the job image), including the changed `patient-results-unavailable.spec.ts`.
- [x] T007 Screenshots in the staging-style build at 1280 and 390 px, light and dark, before and after (the walkthrough and the after captures).

Slice D (a cleaner look):

- [x] T008 Chat home (D6): `ConversationWelcome` buttons, `onAttach` from `WorkspaceConversation`; `WorkspacePage.test.tsx` (the attach button opens the file chooser; a member without roles sees no buttons).
- [x] T009 On demand (D7): `components/ui/InfoButton.tsx`; Follow-up section and New patient page; `FollowupsSection.test.tsx` (hidden by default, opens, paused notice unaffected).
- [x] T010 Refresh icons (D8) in `MedicationsSection` and `FollowupsList`, names unchanged.
- [x] T011 Drug field (D9): `DrugPicker` hint and placeholder, `MedicationForm` add preamble removed, `DrugListInformation` gains the search sentence.
- [x] T012 Checks and screenshots: as T006 and T007.
- [ ] T013 Before a PR: the full local loop (memory, worker, PostgreSQL and S3 tiers), gitleaks, and the founder's browser check of the chat home, the patient record and the medication form.
