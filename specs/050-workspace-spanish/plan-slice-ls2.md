# Plan: spec 050, slice LS2, the shell in Spanish

**Status**: **approved by the founder on 2026-11-25: LS2-D1 to LS2-D6 as recommended.** Read against `main` at `85ad609d`, after #470
(LS1, the language layer). LS2a is built in the pull request after the one that merges this plan; LS2b waits for the founders' Spanish.

LS2 translates the first screens: the **`shell`** and **`sign-in`**. As before, nobody can choose Spanish until LS6 (LS-D2). LS2 is split
in two (LS2-D6), so the first half can land before any Spanish exists.

## 1. What the shell is today

LS1 names two screens:
- **`shell`**: the whole frame (`AppFrame`), which is the sidebar with its account menu, or the public header and footer.
- **`sign-in`**: `/signin` and `/signed-out`.

Their fixed strings, read on `main`:

| Where | About | How written now |
| --- | --- | --- |
| `WorkspaceSidebar.tsx`, `SidebarLink.tsx`, `workspace/FollowupsNavLink.tsx` | 14: the destinations (Home, Chat, Patients, Reports, Follow-ups, Usage, and the local build's two), "Expand/Collapse sidebar", "Workspace navigation", "Sidebar width", the resize hint, Recents | Inline |
| `SidebarAccountMenu.tsx` | 11: Settings, Language, Help, Theme (Auto, Light, Dark), Learn more and its five links, Sign out, "Current language", "Español: aún no disponible" | Inline |
| `SiteHeader.tsx`, `SiteFooter.tsx`, `SkipLink.tsx` | 11, in `LANDING_COPY.header` and `.footer` | **Already English and Spanish**, in `lib/landing/landing-copy.ts`. Off the landing, `useShellCopy` always gives English |
| `StorageConsentProvider.tsx` | The consent bar and dialog | **Already English and Spanish** (`EN`, `ES`). Spanish only on the landing |
| `AppFrame.tsx` | "Loading page…" | Inline |
| `Breadcrumb.tsx` | Its navigation name | Inline |
| `SignInPage.tsx`, `SignedOutPage.tsx` | 7: headings, the invitation-only sentence, the buttons, "Redirecting…" | Inline |
| `AuthCallbackPage.tsx` (`/auth/callback`) | 8: "Signing you in", its failures | Inline. The route has **no screen name yet** |
| Page titles (`usePageTitle`) on those pages | 3 | Inline |

That is about 55 strings in all. The landing's Spanish for the header, footer, skip link and consent bar is recorded as **"still a draft that
needs a Spanish-speaking reviewer"** (`docs/status/2026-10-31-staging-landing-refresh.md`).

## 2. What LS2 does

### LS2a: tables and preview, English only

1. **Every fixed string above moves into a word table**, English only, with no change on screen:
   - `lib/words/shell.ts` holds the sidebar, account menu and frame tables;
   - `lib/words/signIn.ts` holds the sign-in, signed-out and callback tables.

   A string with a number becomes a function of it, such as "Follow-ups (3)" (`FollowupsNavLink`). `Intl.PluralRules` is used only where a
   word changes with the count, and none in the shell does today. Name pairs are declared, such as "Collapse sidebar" with its tooltip.
2. **`/auth/callback` is named `sign-in`.**
3. **One source for the header, footer and skip link.** Off the landing, `useShellCopy` returns `LANDING_COPY` in the `shell` screen's
   language, not always English. So the landing and the shell can never say different things (LS2-D2).
4. **The consent bar** follows the landing's language on the landing and the `shell` screen's language elsewhere (LS2-D3).
5. **`SCREEN_TABLES`** maps each screen to its tables, so the R5 check ("a translated screen shows no English fixed string") runs from data
   rather than by hand.
6. **The founders' preview** (LS2-D1, the decision LS1-D5 deferred).
7. **A list for the founders to fill in:** `docs/design/spanish/ls2-shell.md`. It has one row per string, with its key, the English, where it
   shows, any placeholder, any name pair, and a blank Spanish column. A test keeps it in step with the tables, so a string cannot be added
   without a row.

### LS2b: the Spanish

Once the founders send the filled list:
- the Spanish goes into each table's `es`;
- the reviewer and date go in `signedBy` (LS-D4);
- `TRANSLATED_SCREENS` gains `shell` and `sign-in`.

Still nobody outside the preview sees it until LS6.

## 3. Decisions for the founder

- **LS2-D1, how the founders preview their text.** Recommended: **a preview build flag.**
  - `VITE_LANGUAGE_PREVIEW=true` adds one control, "Preview: English / Español", under Language in the account menu.
  - It is allowed only in development and the e2e build. The production build refuses the flag at start-up, as
    `syntheticStagingMode()` refuses a bad value, and a test checks that.
  - So the founders read their Spanish in place on a local stack, and the browser tests drive it.
  - Alternatives:
    - **`?lang=es` in non-production builds:** simpler, but a URL is easy to share by mistake.
    - **Screenshots only,** from a browser test saved as a CI artifact. Nothing to switch, but nothing to click through either.
- **LS2-D2, the landing's draft Spanish.** Recommended: **the founders review the existing Spanish** for the header, footer and skip link,
  and sign it. They do not write it again. The landing and the shell then share one reviewed text. Alternative: write new shell text, and
  leave the landing's draft as it is.
- **LS2-D3, the consent bar.** Recommended: **it follows the app's language off the landing.** Its existing Spanish is reviewed and signed
  under LS2-D2. It is the frame's first visible element, so leaving it English beside a Spanish shell breaks LS-D1 (whole screens).
  Alternative: keep it English off the landing until LS6.
- **LS2-D4, which shell strings count as clinical.** Recommended: **none.** Navigation, theme, help and sign-in strings are interface
  strings: one founder checks them, under LS-D4. Patient labels and report names in Recents are data, and are never translated.
- **LS2-D5, the Language row's own text.** Recommended: **unchanged until LS6.** "Español: aún no disponible" stays, and its Spanish
  translation is written now, for the Spanish shell. LS6 replaces the row with the real choice.
- **LS2-D6, two pull requests.** Recommended: **LS2a, then LS2b.** LS2a is code, English only, the preview and the list, and it can land at
  once. LS2b is only the Spanish, the signers and two screen names. Alternative: one pull request once the Spanish exists, which keeps the
  code waiting on the text.

## 4. What this touches

- **LS2a:**
  - the components in section 1, which read `useWords` in place of inline strings;
  - `lib/landing/landing-language.ts` (`useShellCopy`);
  - `StorageConsentProvider.tsx`;
  - `app/routes.tsx`, for the callback's screen name;
  - `lib/words/shell.ts`, `lib/words/signIn.ts` and `lib/words/index.ts` (`WORD_TABLES`, `SCREEN_TABLES`);
  - the preview control and its guard;
  - `docs/design/spanish/ls2-shell.md`;
  - tests;
  - one status fragment.
- **LS2b:** the `es` and `signedBy` of those tables, `TRANSLATED_SCREENS`, the list's Spanish column, and one status fragment.

## 5. Verification

- **LS2a: nothing visible changes.**
  - Every existing test that reads a shell or sign-in string passes unchanged, because the English is the same text from its new place.
  - New: the list matches the tables, with no missing or extra row.
  - New: the preview flag is refused in a production build.
  - New: the preview control appears only with the flag.
  - The `WORD_TABLES` checks run on every new table.
- **LS2b:**
  - **R5 from `SCREEN_TABLES`:** with Spanish chosen, `shell` and `sign-in` show none of their English values. The control is that with
    English chosen, they show all of them.
  - **R6:** the patient page and the home stay English, marked `lang="en"`.
  - **R7:** the signers are present.
  - **R10:** the name pairs hold in Spanish.
  - **R11:** any date in the shell is `es-PR`.
- **Browser test** (LS2b, through the preview in the e2e build): the sidebar, the account menu, sign-in and signed-out in Spanish, at 375
  and 1280 px.
  - No sideways scroll, because Spanish runs about a fifth longer.
  - axe passes, with `lang` correct.
  - The keyboard paths the English tests cover still work.
- **Defect injection** (sandbox): these must each turn a test red:
  - a key missing from the list;
  - the preview flag accepted in production;
  - an English string left in a Spanish shell;
  - the consent bar left in English.
- **Where it runs:** in an `opensandbox-pilot` job and in CI. This cloud session has no sandbox, so work started here is first run by CI,
  and its defect injection waits for a sandbox job.

## 6. What this does NOT touch

- **Nobody can choose Spanish.** The account menu keeps "Español: aún no disponible" (LS2-D5). The preview exists only in development and
  e2e builds.
- **No screen other than `shell` and `sign-in`.** The home, the patient page, the not-found page and the rest stay English, marked `lang="en"`.
- **No clinical string**, and no guideline wording.
- **No backend, route path, migration or workflow change.**
- **No machine translation.**
- **The landing** keeps its own toggle and storage key. Its Spanish text changes only if the founders correct it under LS2-D2.
- **Staging:** it gets LS2 with a frontend release, and nothing visible changes there.
