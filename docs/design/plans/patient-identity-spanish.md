# Plan: Spanish for the "identity could not be loaded" wording

**Status**: **approved by the founder on 2026-11-24: S-D1 to S-D3 as recommended** (record the signed Spanish, not shown; a separate
spec for the app's language layer; the two pharmacist founders write and sign). Waiting for the signed text, before any code. Read against
`main` after PR #454 (`docs/design/plans/patient-page-identity-outage.md`, B-D2: "English only").

## 1. What exists today

- **The signed-in app is English only.** Its account menu says so: under Language, "English" is checked and "Español: aún no disponible" is
  greyed out (`SidebarAccountMenu.tsx`). Only the public landing has Spanish, through its own language choice
  (`lib/landing/landing-language.ts`), and nothing outside the landing reads that choice.
- **There is no localisation layer outside the landing.** Spec 038's dependencies list it as missing ("a localisation layer outside the
  landing page, and reviewed Spanish clinical wording"). Their acceptance rule: no Spanish clinical sentence ships without a named
  reviewer, and `lang` is set on any passage whose language differs from the page's.
- **Every other screen waits for the same thing.** These are all held until the founders write the Spanish, and none of it is built:
  - the genomic profile's words and glossary (spec 044 G3, `plan-slice-b.md` section 9, `plan-slice-b2.md` section 6);
  - the phenoconversion notice (spec 045 P-D6);
  - the signed-knowledge label (K2-D3);
  - the worklist home (spec 049).

  The rule each of them sets: **the Spanish is written by the founders, not machine translated**.

So Spanish text for the identity warning, on its own, would never be shown. Nothing in the signed-in app can select Spanish.

## 2. The strings

All five live in `IDENTITY_WORDS` (`apps/frontend/src/lib/patientIdentity.ts`):

| Key | English (approved, B-D2) | Where it shows | What the Spanish must keep |
| --- | --- | --- | --- |
| `unknown(label)` | "The patient's identity could not be loaded, so their name and date of birth are not shown. Make sure this is patient [label] before you act on anything below." | In the banner's place, `role="alert"` | The label, inserted as it is. It must not read as "none recorded". It says that the name and date of birth exist but are not shown, and that the reader checks the label before acting. No identity value, ever (spec 025 D7) |
| `retry` | "Retry" | The button's visible text | Short; one word if Spanish allows it |
| `retryName` | "Retry loading the identity" | The button's accessible name | Must **start with** the Spanish `retry` text, so a voice user can say what they see (WCAG 2.5.3, label in name) |
| `section` | "The demographics could not be loaded. Use Retry above." | The Demographics section | Must name the same button as `retry`, word for word. Must not say "none recorded" |
| `held` | "Results, decisions and follow-ups open once the patient's identity has loaded." | In place of the results area | The three things held, and that they open once the identity loads. Use the same words for results, decisions and follow-ups as the rest of the Spanish app will use (S-D3) |

**Terms.** The landing's Spanish already says *etiqueta* for the label and *paciente sintético* for a synthetic patient. The Spanish here
should match it. No other Spanish term for these screens exists yet.

## 3. Decisions for the founder

- **S-D1, what this slice ships.**
  - **(a) Recommended: record the Spanish now, without showing it.**
    - The founders write the five strings and sign them, with names and a date.
    - They go into `patientIdentity.ts` beside the English as `IDENTITY_WORDS_ES`, with the reviewers and date in a comment.
    - A test checks them (section 5).
    - Nothing on screen changes. They are shown by the first slice that builds the app's language layer, so the text is not lost or
      rewritten in the meantime.
  - **(b) Build the language layer now, with these five as its first Spanish.** The account menu would offer Español. The app's language
    would be stored as the landing's is, under its own key and only with consent. Passages in another language would get `lang`. But a
    clinician who picks Español would see five Spanish sentences on an otherwise English app. Every other screen's Spanish is still
    unwritten. That is a worse experience than English throughout, and the layer deserves its own spec (S-D2).
  - **(c) Wait.** Write nothing until the workspace Spanish spec exists, and write these strings with the rest then.
- **S-D2, where the layer is decided.** Recommended: a new spec, "Spanish in the signed-in app". It would cover:
  - the language choice and where it is stored;
  - `lang` on the page and on passages;
  - what shows when a string has no Spanish yet (the English, marked `lang="en"`);
  - collecting every pending Spanish text: G3, P-D6, K2-D3, the glossary, spec 049 and these five;
  - who signs each.

  This plan does not build it under any option except (b).
- **S-D3, who writes and signs.** Recommended: the founder and the co-founder, both pharmacists, as for spec 038's D21 review. The warning
  is patient-safety text, so spec 038's rule applies: a named reviewer for each sentence. It is not machine translated. This plan proposes
  no Spanish text, on purpose.

## 4. What this touches (option (a))

- `apps/frontend/src/lib/patientIdentity.ts`: `IDENTITY_WORDS_ES`, with the same keys as `IDENTITY_WORDS`, and the signers and date in its
  comment. No component reads it.
- `apps/frontend/src/lib/patientIdentity.test.ts` (new): the checks in section 5.
- `docs/clinical-validation/patient-identity-unknown.md`: the Spanish beside the English, with its reviewers. The "English only" line
  becomes "Spanish written and signed, not shown until the app has a language choice".
- One status fragment.

## 5. Verification (option (a))

- **Unit tests in `patientIdentity.test.ts`:**
  - the Spanish table has exactly the English table's keys;
  - `unknown('SYN-TEST')` contains `SYN-TEST` in both languages;
  - each `retryName` starts with its `retry`;
  - each `section` contains its `retry` word for word;
  - no string is empty, and none equals its English (so a copied placeholder fails).
- **Controls:** each check is shown to fail by a broken table: a missing key, a dropped label, a `retryName` that does not start with
  `retry`.
- **Where it runs:** in an `opensandbox-pilot` job, and in CI (`verify`). This cloud session has no sandbox, so work started here is first
  run by CI, and the PR says so.
- **What is not shown:** that a Spanish reader understands the warning the same way. No usability session covers it.

## 6. What this does NOT touch

- No component, route, setting, migration or check change.
- No language choice, and no change to the account menu.
- The landing's language is unchanged.
- No machine translation.
- No other screen's Spanish.

## 7. Slices

- **(a):** one pull request, once the founders send the signed text.
- **(b):** the spec of S-D2 first, then its slices.
- **(c):** nothing now.
