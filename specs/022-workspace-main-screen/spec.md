# Feature Specification: The one-screen workspace as the local preview's main screen (WMS)

**Feature Branch**: `feat/workspace-main-screen`

**Created**: 2026-10-29

**Status**: Approved 2026-10-29 ("Local preview only"). Polish of the workspace itself is later work.

**Input**: The founder asked to make `/local-workspace` (specs/016, rebuilt in specs/021) the main screen. It is development-only by design: its route exists only in development builds, and its upload path and sample answers refuse to run anywhere but `127.0.0.1`. Its answers are fixed examples, so shipping it to production would put written-in-advance answers in front of clinicians; specs/019 and specs/020 cover what a real result view needs first.

## Decisions

- **D1, scope (founder's decision):** local preview only. Production routing, builds and the production home (`/reports` for clinicians) are unchanged.
- **D2, one rule:** `lib/localWorkspace.ts` says when the workspace exists (a development build served on `127.0.0.1`, the same test the page, the sidebar and the sample engine use) and is the only place that decides where the local preview's home is.
- **D3, sign-in:** in the local preview, signing in from the bare home page (`/`) lands on the workspace. A deeper return path (for example a protected page that sent the person to sign in) is kept as before.
- **D4, home link:** the site header's "Open workspace" goes to the workspace in the local preview, for every role; elsewhere it keeps the role-based home.
- **D5, sidebar:** the sidebar's first item reads "Workspace" (was "Workspace preview"), and so do the page title and heading. The synthetic notice on the page stays.

## Out of scope

- Production builds and routes, the public landing, the sample engine, the upload logic, and any polish of the workspace.

## Requirements

- **WMS-1** Outside the local preview, sign-in landing and the header's home link behave exactly as before.
- **WMS-2** In the local preview, signing in from `/` opens `/local-workspace`, and "Open workspace" points there.
- **WMS-3** A production build still has no workspace route or link.
