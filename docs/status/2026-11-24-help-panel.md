# The Help panel, H2: sidebar drawer, contextual articles, search and patient-question refusal (spec 051)

Date: 2026-11-24

Implemented Spec 051 slice H2 (the curated Help panel) in `apps/frontend`:

- **Help button & drawer:** Added a Help button in `WorkspaceSidebar` above the account menu (with collapsed-sidebar tooltip support) opening the canonical `ContextDrawer` (`id="help-drawer"`). Escape closes the drawer and returns focus to the button.
- **Screen & role context (`helpContext.ts`):** Maps the current route to `HELP_SCREENS` and filters `HELP_EN.articles` by the viewer's roles so roles never see how-tos for features they cannot use.
- **Deterministic search (`helpSearch.ts`):** Zero-model search over role-filtered articles and `GLOSSARY_EN` (marked as words), ignoring accents, case, repeated spaces, and English/Spanish filler words; weights title/keyword matches above body matches; breaks ties by current screen then alphabetically; shows the weak-match banner and up to three closest items when the best hit matches fewer than half the query words.
- **Patient-question refusal (`patientRefusal.ts`):** Checked before searching against synthetic patient labels, star alleles/diplotypes/activity scores, English/Spanish patient+clinical words, and bundled drug names paired with patient words. Displays `HELP_EN.refusal.body`, the draft notice, and a link to the patient's results on a patient page.
- **Privacy & draft status:** Zero network calls and zero storage writes while typing or searching; typed text clears on close; every unreviewed article and refusal displays `Draft: not yet reviewed by a pharmacist.`.
- **Tests:** Added unit tests (`patientRefusal.test.ts`, `helpSearch.test.ts`, `HelpDrawer.test.tsx`) and Playwright browser tests (`e2e/help-panel.spec.ts`).
