# Spanish in the signed-in app: LS3a, the patient page's word tables and founder review sheet (spec 050)

Date: 2026-11-25

This builds the first half of spec 050 slice LS3, mirroring LS2a (`docs/status/2026-11-25-workspace-spanish-ls2a.md`). **English only: nothing
changes on screen.**

- **Word tables.** The 50 newly extracted fixed strings of the top-level patient page components now come from typed English-only tables in
  `apps/frontend/src/lib/words/patient.ts` and are registered under `SCREEN_TABLES.patient` alongside the existing 5-string `IDENTITY_TABLE` (55
  strings total across 6 tables):
  - `PATIENT_PAGE_WORDS` (`PatientPage.tsx`, interface);
  - `PATIENT_BANNER_WORDS` (`PatientBanner.tsx`, interface);
  - `DEMOGRAPHICS_WORDS` (`DemographicsSection.tsx`, clinical);
  - `MEDICATIONS_WORDS` (`MedicationsSection.tsx`, clinical, with 4 WCAG 2.5.3 `namePairs`);
  - `RESULTS_WORDS` (`PatientClinicalSections.tsx` and `PatientResults.tsx`, clinical).
- **Clinical sign-off guardrails.** `DEMOGRAPHICS_WORDS`, `MEDICATIONS_WORDS`, and `RESULTS_WORDS` are marked `clinical: true` so `words.test.ts`
  will enforce two named, dated pharmacist signers (R7) as soon as Spanish entries are added in LS3b.
- **Founder review sheet & parity test.** `docs/design/spanish/ls3-patient.md` lists every string in `SCREEN_TABLES.patient` (1 row per key), and
  `apps/frontend/src/lib/words/ls3List.test.ts` keeps the sheet in exact step with the tables.

`TRANSLATED_SCREENS` remains empty and nobody can choose Spanish yet (LS-D2, LS6). No backend, route path, migration, or workflow change.
