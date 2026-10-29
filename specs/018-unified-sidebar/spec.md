# Feature Specification: One sidebar for every signed-in page (SBR)

**Feature Branch**: `feat/unified-sidebar`

**Created**: 2026-10-28

**Status**: Approved 2026-10-28 ("Yes, as recommended"): slice S1 of the component plan. The founder asked for a sidebar with Reports and Upload together for a more compact UI, from shadcn/ui (Radix variant, no badges).

**Input**: Signed-in pages used two layouts: the workspace sidebar on Reports and Upload, and the site header on Settings and Usage. Moving between them changed the whole frame.

## Decisions

- **D1, where:** every signed-in page except the public landing (`/`) and the sign-in flow (`/signin`, `/auth/callback`, `/signed-out`) uses the workspace sidebar. Settings and Usage join Reports and Upload.
- **D2, links:** Reports and Upload report (by clinical role), Usage (administrators), Settings, Overview: the same role rules as before. An administrator with no clinical role no longer sees a Reports link that leads to "no access".
- **D3, collapse:** on desktop the sidebar collapses to icons (4.5rem) and expands again. The choice is kept in this browser (`localStorage`, only the word `collapsed`); blocked storage just means it starts expanded. Collapsed links keep their names for assistive technology and show them as a tooltip (`title`). Sign out stays one click away as an icon.
- **D4, mobile:** unchanged: the existing disclosure menu, which the browser suites already cover.
- **D6, Sign out lives in the sidebar:** at its foot, styled like the navigation (an icon and the words), under "Signed in as …". The founder found the upper-right Sign out unsightly (2026-10-28), so the site header no longer has one: signed in, it offers **Open workspace** (Reports for clinical roles, Usage for administrators, otherwise Settings). Settings keeps its own Sign out.
- **D5, built in place:** modeled on the shadcn/ui Sidebar's collapsible="icon" pattern without new dependencies.
