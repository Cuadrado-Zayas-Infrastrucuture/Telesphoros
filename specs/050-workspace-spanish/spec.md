# Feature Specification: Spanish in the signed-in app (LS)

**Feature Branch**: `claude/magical-cannon-1cbgkk` (this specification). Each slice gets its own branch and pull request off `main`.

**Created**: 2026-11-24

**Status**: **proposed, 2026-11-24. Not approved.** Specification only: no code, route, setting, migration or knowledge change. It is
S-D2 of [the identity-wording Spanish plan](../../docs/design/plans/patient-identity-spanish.md), which the founder approved on 2026-11-24:
"a separate spec for the app's language layer". It also gathers every Spanish text that other specs have left waiting.

The founder's direction still bounds every choice: **clear to a prescriber or pharmacist with no PGx background, and simple and enjoyable
to work with.** For a language, that means: a clinician who chooses Spanish reads a whole screen in Spanish, never a mix they have to
untangle, and every clinical sentence was written and signed by a pharmacist.

## 1. What is there today (read from `main` at `f8349520`, 2026-11-24)

- **Only the public landing has Spanish.**
  - `lib/landing/landing-language.ts` holds its choice: English unless the visitor picks Spanish, whatever the browser's language. It is
    stored under `telesphoros.landing.language` only with consent (`storageConsent.ts`).
  - `ProductLanding.tsx` sets `<html lang>` while the landing shows.
  - The copy lives in one table with English and Spanish side by side (`landing-copy.ts`).
  - Nothing outside the landing reads the choice (`useShellCopy` returns English off the landing).
- **The signed-in app is English only, and says so.** In the account menu (spec 034 D10, `SidebarAccountMenu.tsx`), Language shows
  English as current, with "Español: aún no disponible" greyed out and marked `lang="es"`.
- **Its strings are mostly inline.** About 219 component files write their English directly in JSX. Only a few word tables exist:
  - `lib/genomicProfileWords.ts`, with the profile's words, the glossary's chrome and the decision control;
  - `lib/patientIdentity.ts`, with the identity-unknown wording;
  - `lib/uploadSteps.ts`.
- **Shared wording comes from packages:**
  - `REASON_MESSAGES` and `REVIEWER_ACTIONS` (`packages/cpic-schema/src/vocabulary.ts`): the fixed words for a hold's reason code and
    the reviewer's action, shown on screen;
  - the glossary, `packages/help-content/src/glossary.en.json`, whose entries are `draft` until two pharmacists sign them.
- **API errors reach the screen as the frontend's own fixed text.** The `lib/` read functions map a status and reason to a fixed sentence
  (for example `getDemographics`), so no server message needs translating.
- **Dates and numbers follow the browser, not any language choice.** Screens call `toLocaleString()`, `toLocaleTimeString()` and
  `Intl.DateTimeFormat(undefined, …)`.
- **Guideline wording is quoted exactly.** CPIC text is shown as the source wrote it and is not translated by the product (spec 038
  dependencies).

### Spanish already waiting, by owner

| Where | What | Its rule |
| --- | --- | --- |
| Spec 044 G3, `plan-slice-b.md` section 9, `plan-slice-b2.md` section 6 | The genomic profile's words and sentences (D4), and the glossary (`glossary.es.json`) | The founders write it; not machine translated |
| Spec 044 K2-D3 | The signed-knowledge label | The founders write it, before K2c |
| Spec 045 P-D6 | The phenoconversion notice and its glossary entry | Draft until signed |
| Spec 038 D8 and dependencies | Outcome labels, hold messages, reason messages (`REASON_MESSAGES`), decision labels | "No Spanish clinical sentence ships without a named reviewer" |
| Spec 049 | The worklist home's fixed strings | English until the founders write the Spanish |
| `docs/design/plans/patient-identity-spanish.md` | The five identity-unknown strings | Signed by the two pharmacist founders, recorded and not shown until this spec's choice exists |
| Spec 003 D9 | Assistant explanations | Its own glossary, sensors and review: **not this spec** |

## 2. What this spec does

1. **A language choice for the signed-in app.** It is English or Spanish, chosen in the account menu's Language row, and English by
   default.
2. **One way to hold a screen's words.** Every translated screen reads its fixed strings from a table with English and Spanish side by side.
   It never reads them inline.
3. **Whole screens, not loose strings.** A screen is offered in Spanish only when all of its fixed strings have signed Spanish (LS-D1).
4. **A sign-off recorded beside each clinical string**, the way the glossary records it.
5. **The order in which screens are translated**, and when the choice is first offered to people (LS-D2, LS-D8).

It writes no Spanish. The text is the founders' (LS-D4).

## 3. Rules

| # | Rule | How it is checked |
| --- | --- | --- |
| R1 | The app's language is English unless the person chooses Spanish. The browser's language is never followed, as on the landing | Unit test: a Spanish browser with no choice gets English |
| R2 | The choice is stored only with consent, under its own key (`telesphoros.app.language`), and lasts for the session without storage | Test, as `landing-language`'s; `PREFERENCE_KEYS` lists the key |
| R3 | `<html lang>` follows the app's language. A passage in the other language carries its own `lang`, such as quoted guideline text (`en`) on a Spanish screen | Unit and browser tests read `lang` |
| R4 | Every word table has the same keys in both languages. A placeholder (a label, a count) appears in both | The types refuse a missing key; a test checks placeholders |
| R5 | A screen marked as translated renders no English fixed string when Spanish is chosen | Per screen: render in Spanish and look for each English value of its tables |
| R6 | A screen not yet translated stays wholly English under a Spanish choice, with `lang="en"` on its main region. It never mixes | Test: an untranslated screen under Spanish shows only English |
| R7 | A clinical or patient-safety string carries its signers (two pharmacists, names and a date) in its table, or it is not shown in Spanish | A test refuses a clinical Spanish entry without two signers |
| R8 | Nothing is machine translated | A process rule, stated in the PR template's Spanish line (slice LS1) |
| R9 | No identity value is part of any string, in either language: only the synthetic label is inserted (spec 025 D7) | The existing privacy tests, plus R4's placeholder check |
| R10 | A control's accessible name starts with its visible text in both languages (WCAG 2.5.3) | Test per table where a name and a visible word are paired |
| R11 | Dates and numbers follow the app's language (`es` or `en` to `Intl`) on translated screens. Time zones are unchanged | Unit test on the shared formatter |
| R12 | Guideline wording, drug names, gene symbols, star alleles and reason codes are never translated (LS-D3) | Test: they appear identically in both languages |

## 4. Decisions for the founder

- **LS-D1, the unit of translation.** Recommended: **a whole screen.** Spanish is offered for a screen only when every fixed string on it
  has signed Spanish. Until then the screen stays English, marked `lang="en"` (R6). Alternative: string by string, which leaves screens
  half in each language. On a clinical screen that is harder to read and easier to misread.
- **LS-D2, when the choice is first offered.** Recommended: when a **first set** of screens is complete. That set is the shell (sidebar,
  account menu, sign-in pages), the home (spec 049), the patient page and the genomic profile. Before then the account menu keeps "Español:
  aún no disponible", and the Spanish is exercised only in tests. Alternative: offer it as soon as the shell is done, with every other screen
  English (R6).
- **LS-D3, what is never translated.** Recommended:
  - guideline wording, quoted exactly;
  - drug names, gene symbols, star alleles and diplotypes;
  - reason codes.

  CPIC's phenotype terms ("Poor Metabolizer") stay in English beside a Spanish explanation in the glossary, so the screen matches the
  report and the guideline. That last point is the founders' call as pharmacists. Alternative: translate the phenotype terms too.
- **LS-D4, who writes and who signs.** Recommended:
  - **clinical and patient-safety strings** (hold, reason and decision words, the profile and notice sentences, the identity warning, the
    glossary): written by the founders, signed by two pharmacists with names and a date (R7);
  - **interface strings** (navigation, buttons, empty states, form labels): written by the founders and checked by one founder.

  Neither is machine translated (R8).
- **LS-D5, the mechanism.** Recommended: **the project's own small layer, no library.** It has:
  - a `useAppLanguage()` hook, built like `useLandingLanguage`;
  - per-feature tables of the form `{ en: {…}, es: {…} }`, typed so that a missing Spanish key does not compile;
  - `Intl.PluralRules` where a count needs it.

  Strings move out of inline JSX into a table **screen by screen, as each one is translated**, never in one big extraction. Alternative:
  an i18n library (i18next, FormatJS). That brings message syntax and tooling, but adds a dependency to vet, and the project's text needs
  are small.
- **LS-D6, the shared vocabularies.** Recommended: the Spanish for `REASON_MESSAGES` and `REVIEWER_ACTIONS` lives in the same package,
  beside the English, keyed by reason code. The glossary gets `glossary.es.json` beside `glossary.en.json`, with the same ids and schema.
  The English stays the record: what is stored and audited does not change with the reader's language.
- **LS-D7, dates and numbers.** Recommended: they follow the app's language through one shared formatter (R11), applied as each screen is
  translated. Alternative: keep following the browser. On a Spanish screen in an English browser, that gives English month names.
- **LS-D8, the order of slices.** Recommended: as section 5. The first-set screens come first, and their order follows the founders'
  writing.

## 5. Slices

| Slice | What | Needs first |
| --- | --- | --- |
| **LS1** | The layer: `useAppLanguage`, the stored choice (R1, R2), `<html lang>` (R3), the table type and parity test (R4), the sign-off check (R7), the shared formatter (R11), the screen-level `lang="en"` rule (R6), the PR template's line (R8). The account menu is unchanged (LS-D2) | This spec approved |
| **LS2** | The shell: sidebar, account menu, sign-in and signed-out pages | LS1; the founders' Spanish for the shell |
| **LS3** | The patient page. It includes the five identity strings recorded under `patient-identity-spanish.md`, the demographics, the medications, and the results' hold, reason and decision words (LS-D6) | LS1; signed Spanish (R7) |
| **LS4** | The genomic profile and `glossary.es.json` (spec 044 G3, K2-D3, spec 045 P-D6) | LS1; signed Spanish |
| **LS5** | The home (spec 049), once it is built | LS1; spec 049's slices |
| **LS6** | The choice is offered: the account menu's Language row lists Español as selectable (LS-D2) | LS2 to LS5 |
| Later | Every other screen, one slice each, in the order the founders choose | LS1 |

Each slice: one pull request, a status fragment, the tests of section 3 for its screens, and the Spanish with its signers in the
pull request.

## 6. Verification

- **Unit tests:** R1 to R12, each with a control that passes and a broken table or screen that fails:
  - a missing key;
  - a dropped placeholder;
  - a clinical entry with one signer;
  - an English string left on a screen marked as translated;
  - a mixed untranslated screen.
- **Browser tests:** for each translated screen, at 375 and 1280 px, in Spanish:
  - no sideways scroll (Spanish runs longer);
  - axe, with `lang` correct on the page and on passages;
  - the keyboard paths the English tests already cover.
- **Where they run:** in `opensandbox-pilot` jobs and in CI (`verify`, `browser`).
- **What is not shown:** that Spanish-reading clinicians understand the screens as the English ones are understood. A usability session
  in Spanish (`docs/design/clinical-workspace-usability-protocol.md`) is a later step, before Spanish is used with anyone outside the team.

## 7. Not in scope

- The assistant's explanations in Spanish (spec 003 D9).
- The landing, which already has its own Spanish.
- Emails from Cognito and SES.
- The documentation, and server logs.
- Translating guideline wording (LS-D3).
- Any language other than English and Spanish.
- Changing what is stored or audited.
- Releasing to staging: each slice reaches staging with a frontend release, the founder's step, and that release's plan quotes
  `scripts/staging/staging-status.sh`.

## 8. Open after approval

- **The Spanish itself, screen by screen.** It is the founders' (LS-D4). No slice past LS1 starts without it.
- **The five identity strings** are written under `patient-identity-spanish.md` and are shown from LS3.
