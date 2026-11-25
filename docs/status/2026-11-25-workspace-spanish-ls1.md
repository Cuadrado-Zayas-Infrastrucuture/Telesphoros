# Spanish in the signed-in app: LS1, the language layer (spec 050)

Date: 2026-11-25

This builds `specs/050-workspace-spanish/plan-slice-ls1.md`, approved on 2026-11-25 with LS1-D1 to LS1-D5 as recommended. **It writes no
Spanish, and nothing changes on screen.**

- **The app's language** (`lib/appLanguage.ts`):
  - English unless chosen, never the browser's;
  - stored as `telesphoros.app.language`, only with consent, apart from the landing's.
- **Word tables** (`lib/words/`):
  - their Spanish cannot miss or add a key;
  - a clinical table needs two signers;
  - an accessible name starts with its visible word;
  - every table is checked from one index.
- **Screens:**
  - named on their routes (`handle.screen`): `home`, `patient` and `sign-in`, with the frame as `shell`;
  - `TRANSLATED_SCREENS` is empty, so every screen stays English. In Spanish, a screen would be marked `lang="en"` on its own root, with
    no wrapper element.
- **One owner of `<html lang>`:** `AppFrame` replaces the landing's own set-and-reset.
- **Dates and numbers:** `useFormat()` uses `es-PR` or `en-US` on a translated screen, and the browser's locale elsewhere, as before.
- **The patient page's identity wording** is now the first table, `IDENTITY_TABLE`, still English.
- **The pull-request template** has a line on Spanish.

The account menu still says "Español: aún no disponible". No backend, route path, migration or workflow change.
