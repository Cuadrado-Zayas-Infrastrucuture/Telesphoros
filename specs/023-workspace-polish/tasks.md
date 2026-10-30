# Tasks: Polish the one-screen workspace

- [x] T001 Browser tests first (`local-e2e/workspace-polish.spec.ts`), each failing on the screen before this spec (WP-1 to WP-7). On the old screen nothing was covered once scrolled to the end; WP-1 failed on the bar's height (321 px of 844, now 201)
- [x] T002 Bottom bar: one row of short sample questions, compact on a phone; the end of an answer scrolls clear (D2, D4)
- [x] T003 Empty-state heading, notice under the input, A/C/G/T letters removed (D3, D7, D8)
- [x] T004 Attached report row on clean lines, full patient choice, full confirmation sentence (D5)
- [x] T005 Feedback wording (D6); unit tests that named the old wording updated
- [x] T006 Full local loop, including `check:chunks` and both browser configs; gitleaks (2026-10-30: every ci.yml step except the FHIR IG test, service tiers and terraform; e2e 161+46+2 passed, 3 skipped; frontend unit 539; backend unit 1970 passed, 385 skipped; launcher-cors 5/5 under Python 3.12 with moto)
- [x] T007 Screenshots at 390, 768 and 1280 px, light and dark, before and after, sent to the founder before any commit
