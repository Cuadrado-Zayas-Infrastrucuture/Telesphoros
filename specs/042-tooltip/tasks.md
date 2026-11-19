# Tasks: A tooltip that names an icon button

Front end only; one new package. No API, schema, setting or infrastructure change. The plan is the decisions in [spec.md](spec.md).

- [x] T001 Component (D1, D4): `components/arc/Tooltip.tsx` and `styles/tooltip.css`.
- [x] T002 Credit (D5): `components/arc/LICENSE.md` and `components/arc/README.md`, with the upstream commit and what was changed.
- [x] T003 Unit tests: `components/arc/Tooltip.test.tsx` (closed by default and no `title`; opens on keyboard focus; Escape hides it and keeps focus; opens on hover; a disabled control shows none; no accessibility violations while open). `test/setup.ts` gains a `ResizeObserver` stand-in, which jsdom lacks and the placement code needs.
- [x] T004 First use (D2): `MedicationsSection` and `FollowupsList` wrap their Refresh button in `Tooltip` and drop `title`.
- [x] T005 Use test: `FollowupsSection.test.tsx` (on the patient page both Refresh buttons keep their names, carry no `title`, and show the name on focus).
- [ ] T006 Package: `@radix-ui/react-tooltip` added to `apps/frontend/package.json` and `pnpm-lock.yaml` (the founder runs the install; it needs the network).
- [ ] T007 Sandbox image rebuilt from the new lock file and the gateway restarted (the founder's steps), so the checks can run offline.
- [ ] T008 Checks in the sealed sandbox: typecheck, lint, format, unit tests, build, chunk and foundation checks, brand check. Fix what they find.
- [ ] T009 Browser check on the patient page at 1280 and 390 px, light and dark: the label on hover and on Tab, Escape, the window's edge, reduced motion, and the two existing browser suites that press "Refresh medications".
- [ ] T010 Before a PR: the full local loop, gitleaks, a VoiceOver listen (spec, "Not verified"), and the founder's own look.
