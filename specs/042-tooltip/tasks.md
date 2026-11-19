# Tasks: A tooltip that names an icon button

Front end only; one new package. No API, schema, setting or infrastructure change. The plan is the decisions in [spec.md](spec.md).

- [x] T001 Component (D1, D4): `components/arc/Tooltip.tsx` and `styles/tooltip.css`.
- [x] T002 Credit (D5): `components/arc/LICENSE.md` and `components/arc/README.md`, with the upstream commit and what was changed.
- [x] T003 Unit tests: `components/arc/Tooltip.test.tsx` (closed by default and no `title`; opens on keyboard focus; Escape hides it and keeps focus; opens on hover; the control is described by the label only while it shows; a disabled control shows none; no WCAG A or AA violations while open, on the whole document). `test/setup.ts` gains a `ResizeObserver` stand-in, which jsdom lacks and the placement code needs.
- [x] T004 First use (D2): `MedicationsSection` and `FollowupsList` wrap their Refresh button in `Tooltip` and drop `title`.
- [x] T005 Use test: `FollowupsSection.test.tsx` (on the patient page both Refresh buttons keep their names, carry no `title`, and show the name on focus).
- [x] T006 Package, 2026-11-18: `@radix-ui/react-tooltip` `^1.4.1` in `apps/frontend/package.json`; `pnpm-lock.yaml` gained 22 packages (Radix parts and Floating UI), each with a checksum, and lost none. Commit `38c22b1e`.
- [x] T007 Sandbox image rebuilt from `38c22b1e` and the gateway restarted, 2026-11-18 (the founder's steps). An upload then reads `lockfile: match`.
- [x] T008 Checks in the sealed sandbox, 2026-11-18, on the new image: typecheck, lint and format check exit 0; the front end's tests pass (63 script tests, 1,104 unit tests in 91 files, 155 s); build, chunk and foundation checks (194 components) and the brand check exit 0; the one-version-range test passes. The tooltip's code and its 347-byte stylesheet land only in the patient page's lazy chunk. One test failed on the first run and was changed: the accessibility test ran axe's every rule on the whole document, and the best-practice `region` rule flagged the label (spec, "Known and accepted"); it now uses the app's WCAG A and AA set. Two controls, both red as they should be: an empty label fails three tooltip tests, and a restored `title` fails the patient-page test.
- [ ] T009 Browser check on the patient page at 1280 and 390 px, light and dark: the label on hover and on Tab, Escape, the window's edge, reduced motion, and the two existing browser suites that press "Refresh medications".
- [ ] T010 Before a PR: the full local loop, gitleaks, a VoiceOver listen (spec, "Not verified"), and the founder's own look.
