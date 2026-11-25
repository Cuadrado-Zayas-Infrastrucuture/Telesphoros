# Plan: spec 050, slice LS1, the language layer

**Status**: **approved by the founder on 2026-11-25: LS1-D1 to LS1-D5 as recommended.** Read against `main` at `64253c3d`, after #461
(spec 050, approved with LS-D1 to LS-D8 as recommended). Built in the pull request after the one that merges this plan.

LS1 builds the layer every later slice uses. **It writes no Spanish, and nothing changes on screen.** The account menu keeps "Español: aún
no disponible" (LS-D2). The Spanish choice can be set only by tests until LS6.

## 1. What is there now

- **The landing's language** lives in `lib/landing/landing-language.ts`:
  - it is a `useSyncExternalStore` store that defaults to English and never follows the browser;
  - it is stored as `telesphoros.landing.language` through `preferenceStorage`, so only with consent;
  - the key is in `PREFERENCE_KEYS` (`lib/storageConsent.ts`), in `docs/design/storage-consent.md` and in `e2e/storage-consent.spec.ts`.
- **`<html lang>`:** `index.html` says `en`. `ProductLanding.tsx` sets the landing's language while it shows and resets it to `en` when it
  unmounts. It is the only code that touches the attribute.
- **Dates:** `lib/formatWhen.ts` has `when` and `onDate`, which use the browser's locale (`undefined`), in 8 files. Other screens call
  `toLocaleString()` directly.
- **Word tables:** `IDENTITY_WORDS` (`lib/patientIdentity.ts`), `PROFILE_WORDS` and its siblings (`lib/genomicProfileWords.ts`), and
  `lib/uploadSteps.ts`. They are plain `as const` objects, English only.
- **Routes:** `app/routes.tsx` uses data routes, so a route can carry a `handle`. `AppLayout` mounts `StorageConsentProvider` around
  `AppFrame`.

## 2. What LS1 adds

| # | Piece | Where | Spec rule |
| --- | --- | --- | --- |
| 1 | **The app's language.** `AppLanguage = 'en' \| 'es'`, a store like the landing's (`useAppLanguage()`, `setAppLanguage()`), under its own key `telesphoros.app.language`. English by default, never the browser's language. Without storage the choice lasts for the session | new `lib/appLanguage.ts`; `PREFERENCE_KEYS`; `docs/design/storage-consent.md`; `e2e/storage-consent.spec.ts` | R1, R2 |
| 2 | **Word tables.** `defineWords({ id, en, es?, clinical?, signedBy?, namePairs? })`. When `es` is present, it must have exactly `en`'s shape, so a missing key does not compile. A value is a string or a function of its placeholders (as `IDENTITY_WORDS.unknown(label)` is today). Every table is listed in one index, `WORD_TABLES`, for the checks | new `lib/words/defineWords.ts`, `lib/words/index.ts` | R4, R7, R10 |
| 3 | **Screens.** A route names its screen in `handle.screen`. `TRANSLATED_SCREENS` lists the screens that have signed Spanish, and **is empty in LS1**. `ScreenLanguage` gives a screen its effective language: Spanish only when the app's language is Spanish *and* the screen is listed. Otherwise English, with `lang="en"` on the screen's root when the app is in Spanish. `useWords(table)` returns the table's words in that effective language | new `lib/words/screens.ts`, `components/layout/ScreenLanguage.tsx`; `AppFrame` wraps the outlet; the sidebar is the `shell` screen | R5, R6 |
| 4 | **One owner of `<html lang>`** (LS1-D1). `AppFrame` sets it: the landing's language on the landing, and the app's language elsewhere. `ProductLanding`'s own effect is removed | `AppFrame.tsx`, `ProductLanding.tsx` | R3 |
| 5 | **Dates and numbers.** A `useFormat()` hook gives `when`, `onDate` and a number formatter bound to the screen's effective language: `es-PR` or `en-US` on a translated screen (LS1-D4), and the browser's locale on every other screen, as today. The plain `when` and `onDate` stay for the screens that do not use the hook yet | `lib/formatWhen.ts` | R11 |
| 6 | **The first table in the new form** (LS1-D3). `IDENTITY_WORDS` becomes `defineWords({ id: 'patient-identity', clinical: true, en: {…}, namePairs: [['retry', 'retryName']] })`, still English only. Its text and the page do not change | `lib/patientIdentity.ts`, `IdentityUnknown.tsx`, `PatientPage.tsx`, `DemographicsSection.tsx` | proves 2 and 3 on a real screen |
| 7 | **The pull-request line** for R8 (section 3) | `.github/pull_request_template.md` | R8 |

The screens mapped to routes in LS1:
- `shell`, which is the sidebar and account menu;
- `home`, which is `/workspace`;
- `patient`, which is `/patients/:id`;
- `sign-in`, which covers `/signin` and `/signed-out`.

Every other route has no `handle.screen`, which means "not translated": the same as being unlisted.

## 3. The pull-request line (R8)

One line is added under "Safety invariants" in `.github/pull_request_template.md`:

> - [ ] **Spanish:** any Spanish text in this PR was written by the founders, not machine translated, and every clinical string names
>   two pharmacist signers and a date (spec 050 R7, R8). Or this PR adds no Spanish.

## 4. Decisions for the founder

- **LS1-D1, one owner of `<html lang>`.** Recommended: `AppFrame` sets it from the landing's language on the landing and from the app's
  language elsewhere. `ProductLanding`'s own effect goes. Two effects that set and reset the same attribute can leave the wrong language
  after a navigation. Alternative: keep the landing's effect and add a second one for the app.
- **LS1-D2, how a screen is named.** Recommended: by its route, in `handle.screen`, read once in `AppFrame`. A route with no name is "not
  translated" by default (R6), so no page file changes. Alternative: wrap each page in `ScreenLanguage` by hand. That touches every page, and
  a forgotten wrapper is silent.
- **LS1-D3, move `IDENTITY_WORDS` now.** Recommended: yes, still English only, so the layer has one real user and its tests run on a real
  screen. It is also the table whose Spanish comes first (`patient-identity-spanish.md`). Alternative: leave every table as it is until LS2.
- **LS1-D4, the locales for dates and numbers.** Recommended: `es-PR` for Spanish and `en-US` for English. The founders and the first
  clinicians are in Puerto Rico. Either way, this applies only on translated screens (R11). Alternatives: `es` and `en`, which leave the
  browser's region to decide some forms, or `es-US`.
- **LS1-D5, no way to preview Spanish in the app.** Recommended: none in LS1. There is no menu entry, URL parameter or build flag;
  `setAppLanguage` is called only by tests. A preview for the founders, for reading their own text in place, is decided with LS2, when
  there is Spanish to read.

## 5. Verification

- **Unit tests.** Each test has a control that passes and a broken case that fails.
  - **R1:** a browser in Spanish with no choice gets English.
  - **R2:**
    - the choice is stored only after consent;
    - it lasts for the session without storage;
    - withdrawing consent removes it (the existing `StorageConsentProvider` tests iterate `PREFERENCE_KEYS`).
  - **R3:**
    - `<html lang>` is `en` on the signed-in app with English chosen, and `es` with Spanish chosen;
    - it follows the landing's choice on the landing;
    - it does not keep the landing's Spanish after leaving the landing.
  - **R4**, over `WORD_TABLES`:
    - the keys match in both languages;
    - every function value keeps its placeholder in both, checked with a sentinel label;
    - a Spanish value equal to its English fails.
    - Control: a test-only table with a missing key fails to type-check (a `// @ts-expect-error` line).
  - **R5 and R6, with a test-only screen:**
    - listed in `TRANSLATED_SCREENS` with Spanish chosen, it shows only Spanish;
    - unlisted, it shows only English, with `lang="en"` on its root;
    - the patient page under Spanish shows English throughout, because it is not listed in LS1.
  - **R7:** a `clinical` table with Spanish and fewer than two signers fails. With two, it passes.
  - **R10:** for each `namePairs` entry, the name starts with its visible word, in both languages.
  - **R11:**
    - `useFormat()` on a translated test screen formats a fixed date with `es-PR` and with `en-US`;
    - on an untranslated screen it matches the browser's locale, as today.
  - **Unchanged:** the identity-unknown tests in `PatientPage.test.tsx` pass with `IDENTITY_WORDS` in its new form (LS1-D3).
- **Browser test**, an addition to `e2e/storage-consent.spec.ts` and `e2e/landing-language.spec.ts`:
  - the new key follows consent;
  - `<html lang>` is `es` on the landing in Spanish and `en` after signing in.
- **Defect injection, in a sandbox job:**
  - follow the browser's language;
  - drop the key from `PREFERENCE_KEYS`;
  - list nothing and still show Spanish;
  - accept a clinical entry with one signer;
  - restore `ProductLanding`'s reset.

  Each must turn a test red.
- **Where it runs:** in an `opensandbox-pilot` job and in CI (`verify`, `browser`). This cloud session has no sandbox, so an implementation
  started here is first run by CI, and its defect injection waits for a sandbox job, as with #454.

## 6. What this does NOT touch

- No Spanish text, and no screen translated: `TRANSLATED_SCREENS` stays empty.
- The account menu still says "Español: aún no disponible". No preview control.
- No other word table or inline string moves, except `IDENTITY_WORDS` (LS1-D3).
- No raw `toLocaleString()` call changes. They move as their screens are translated.
- No backend, route path, migration, knowledge or CI workflow change. The only CI-adjacent change is the PR template's one line.
- The landing's copy, its toggle and its storage key are unchanged.
- Staging gets it with a frontend release, the founder's step, and nothing visible changes there.

## 7. Slices

One pull request: the code, the tests, the storage-consent document's new row, the PR template line, and one status fragment.
