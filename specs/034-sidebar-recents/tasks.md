# Tasks: A sidebar laid out like a chat app

Frontend only; no API, schema or migration change. The plan is the decisions in [spec.md](spec.md), built in this order.

- [x] T001 `/patients` page (D2): `PatientsPage` with Add patient for writer roles, and `PatientRoster` (moved from `SidebarPatients`) with the find box, More patients and the demographics line. Route under the clinical read roles; `check-chunks.mjs` lists the new lazy page.
- [x] T002 Recents (D3, D7): `SidebarReports` becomes one-line rows (name without extension, status word from `ReportStatusText`), each opening its report on `/reports`; `ReportsPage` opens a handed-over report once its first page has loaded, so the details are not hidden behind the Report history drawer.
- [x] T003 `WorkspaceSidebar` order (D1, D5, D6): brand with the collapse control, New chat, destinations, Recents taking the remaining height, account at the foot; wordmark only; 17rem default.
- [x] T004 Drag to resize (D8): a slider on the right edge, mouse and keys, bounds 14-24rem, double click resets; `telesphoros.sidebar-width` joins the consent-gated preference keys and `docs/design/storage-consent.md`.
- [x] T005 Account menu (D4, D9-D11): `SidebarAccountMenu` with the name and email, Settings, Language, Help, Theme, Learn more and Sign out; links from `lib/helpLinks.ts`; focus and arrow keys; 36px rows under a mouse (`--size-control-compact`), 44px on touch.
- [x] T006 Unit tests: `WorkspaceSidebar.test.tsx`, `PatientsPage.test.tsx` (the Add patient and demographics tests moved from the sidebar), `routes.test.tsx`, `SettingsPage.test.tsx`.
- [x] T007 Browser tests follow the new places: helpers `openAccountMenu`, `signOutFromSidebar`, `openPatients`; "All reports" is "Reports"; Patients and Add patient are on `/patients`; a resize test in `e2e/sidebar.spec.ts`.
- [x] T008 Screenshots at 1280×800 and 375 wide from the local preview, reviewed by the founder at each step ("Good, finish it", 2026-11-05).
- [ ] T009 Full local loop, the browser configs that cover the sidebar, and gitleaks 8.30.1; results recorded here.
