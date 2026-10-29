# Tasks: The one-screen workspace as the local preview's main screen

- [x] T001 `lib/localWorkspace.ts`: when the workspace exists, the local home, and the sign-in landing (D2-D4)
- [x] T002 Sign-in callback, "Open workspace" and the sidebar use it; label, title and heading read "Workspace" (D3-D5)
- [x] T003 Unit tests: local landing and home, unchanged elsewhere (incl. a production build on 127.0.0.1), sidebar order; host check broken on purpose twice (WMS-1, WMS-2)
- [x] T004 Browser tests: local sign-in from `/` opens the workspace; production has no workspace link or route and sign-in from `/` still lands on `/` (WMS-1-3)
- [ ] T005 Full local loop, including `check:chunks` and both browser configs; gitleaks
