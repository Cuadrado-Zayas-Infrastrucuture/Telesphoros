# Spanish in the signed-in app: LS2a, the shell's tables and the founders' preview (spec 050)

Date: 2026-11-25

This builds the first half of `specs/050-workspace-spanish/plan-slice-ls2.md`, approved with LS2-D1 to LS2-D6 as recommended. **English only:
nothing changes on screen.**

- **Word tables.** The 72 fixed strings of the shell and the sign-in pages now come from word tables, with exactly the same English:
  - `lib/words/shell.ts`: the sidebar with Recents, the account menu and the frame;
  - `lib/words/signIn.ts`: sign-in, signed-out and the sign-in callback, which is now named `sign-in`.
- **`SCREEN_TABLES`** maps each screen to its tables.
- **Shared text.** Off the landing, the header, footer, skip link and consent bar follow the shell's language, so they share one text with the
  landing. The shell stays English until LS2b marks it translated.
- **The founders' preview.** `VITE_LANGUAGE_PREVIEW=true` adds a "Preview: English / Español" control under Language in the account menu. It
  is allowed only in development, test and e2e builds; any other build refuses the flag at start-up.
- **The list to fill in.** `docs/design/spanish/ls2-shell.md` has one row per string, and a test keeps it in step with the tables. It also
  lists the landing's draft Spanish that the shell shares, for review.

Nobody can choose Spanish: the account menu still says "Español: aún no disponible". No backend, route path, migration or workflow change.
