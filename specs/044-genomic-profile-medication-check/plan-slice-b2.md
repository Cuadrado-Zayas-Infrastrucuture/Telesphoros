# Plan: spec 044, slice B part 2, the glossary, the decision control, the signed label and the browser tests

**Status**: **draft, for the founder's approval.** Plan only: no code. Read against `main` after PR #446 (the phenoconversion notice on
the screen). Part 1 (PR #440) built the screen. This part finishes what `plan-slice-b.md` lists and part 1 left out:

| Left out of part 1 | Where in `plan-slice-b.md` | Here |
| --- | --- | --- |
| The glossary, with the founders' signed entries (B-D4) | section 6 | sections 1 and 2 |
| The disabled "Record a decision" control | section 10 | section 3 |
| K2c's signed-knowledge label (it needs the evaluation scope on each result) | section 5 | section 4 |
| The 390 and 1280 px browser tests, light and dark, keyboard only | section 11 | section 5 |
| Spanish | section 9 | not here: it waits for the founders' text (section 6) |

The founder's direction still bounds every choice: **clear to a prescriber or pharmacist with no PGx background, and simple and enjoyable to
work with.**

## 1. The glossary content (B-D4: signed, reviewed content in the repository, shared with the help assistant)

- **Where it lives (B2-D1).** A new workspace package, `packages/help-content`. It holds `glossary.en.json` and a strict zod schema that
  validates it at build and in a test. The frontend imports it. The help assistant (direction plan A3) will read the same file later, so
  the screen and the assistant can never say different things.
- **One entry:**

  ```
  { id, term, aliases[], body, status: "draft" | "signed", signedBy: [{ name, role, date }], reviewedAgainst?: [source] }
  ```

  `aliases` are the exact strings the screen shows ("Poor metabolizer", "Decreased function"), so a term can be linked without guessing.
  `body` is plain text of a few short sentences, with no markup and no links. `status: "signed"` needs two named pharmacists and a date. A
  test refuses a signed entry with fewer, and refuses a `draft` entry that names signers.
- **What an entry may say.** General education about a term, the same for every patient and never about this patient
  (`plan-slice-b.md` section 6). The `body` may not contain "safe", "no interaction", "not affected" or "none". The test that guards the
  screen's text checks this.
- **The first entries.** These are the terms in section 6 of `plan-slice-b.md`:
  - phenotype, diplotype, star allele and activity score;
  - decreased, increased and poor function;
  - normal, intermediate, poor, rapid and ultrarapid metabolizer;
  - Guidance to review, Held and No guideline loaded;
  - **Phenoconversion** (spec 045 N3-D1).

  **B2-D2** decides who writes the first text.

## 2. The glossary on the screen

- **Opened from the word itself (B2-D3).** A term with an entry becomes a small text button wherever the screen shows it: the phenotype
  in "Because SLCO1B1 is Decreased function…", the gene card's phenotype, the word on each row (Guidance to review, Held, No guideline
  loaded), and the notice's bold line (Phenoconversion). It opens the existing `ContextDrawer`. The drawer has native modal semantics,
  Escape closes it, and focus returns to the term.
- **The drawer** shows the term, its body, and at its foot who signed it and when. For a draft it says instead: "Draft: not yet reviewed
  by a pharmacist." It also has a link, "All terms", to the list of every entry, kept in the same drawer.
- **An ⓘ "Words used here"** beside the section heading opens the same list. It explains words and never carries a safety statement
  (spec 041 D7). The always-visible sentences stay where they are.
- A string with no matching entry stays plain text. Nothing is guessed or fuzzy-matched.

## 3. "Record a decision" (spec 044 D9, `plan-slice-b.md` section 10)

Under each matching result's evidence (layer 3):

- **Where decisions are switched on (B2-D4):** a link, "Record a decision on this result". It opens the same patient page with
  `?result=<id>`, and the results list already opens that result there with the existing decision form. The profile does not repeat the
  form: a decision is recorded in one place only, the one spec 006 tested.
- **Where they are not (the synthetic staging, `syntheticStagingMode()`, as `ResultsList` decides today):** a disabled button, "Record a
  decision", with the sentence beside it in plain text, "Decisions are not switched on in this environment." The sentence is never only in
  a tooltip, because a disabled control's tooltip cannot be reached by keyboard (spec 042 D3).
- Nothing is written from the profile in either case.

## 4. The signed-knowledge label (K2c, K2-D3)

- **API addition (B2-D5).** Each `GenomicCheckResult` gains an optional `scope`, copied from its evaluation's stored `scope`
  (`EvaluationSummaryDto.scope`). The builder change is one line, and its test checks the value is copied unchanged and that nothing else
  in the response changes. The field is optional and read strictly, and the frontend and backend ship in the same pull request, as N2 did.
- **On the screen:** a row with at least one result made with signed knowledge shows `SIGNED_KNOWLEDGE_LABEL` once, under the drug's
  name: "Real CPIC guideline wording. Fictional patient. Not approved for clinical use." It reuses `SignedKnowledgeLabel` and
  `usesSignedKnowledge` from K2c, so the wording is the one the founders already approved.

## 5. Browser tests (`apps/frontend/e2e/genomic-profile.spec.ts`)

The e2e backend has no evaluations, so the test serves `GET /patients/:id/genomic-profile` from a synthetic fixture (as
`result-renders.spec.ts` serves its routes). The rest of the page is the real e2e app, with a patient from `signInWithPatient`. The
fixture is invented throughout: genes, phenotypes, a modifier list and placeholder wording.

- **Widths 390 and 1280 px, light and dark:** no horizontal scroll, every row and card readable, and no axe violations (`axeViolations`).
- **Keyboard only:**
  - Tab to a row's "Why, and the evidence", open it with Enter, and reach the evidence.
  - Open a glossary term. Escape returns focus to the term.
  - Open the ⓘ.
- **Targets:** every control in the section is at least 44 px high. **Headings in order:** h2, then h3, h4 and h5, with none skipped.
- **The decision control:** the disabled button and its sentence in the staging mode, and the link in the other.

## Decisions for the founders

- **B2-D1. Where the glossary lives.** **Recommendation:** a small package, `packages/help-content`, with a JSON file and its schema, so
  the screen and the future help assistant read one source. The sign-off is recorded in the file: two named pharmacists and a date,
  enforced by a test. This is not a cryptographic signature: the knowledge-signing keys do not exist yet, and an entry is education, not
  clinical logic. A cryptographic signature can be added when the keys exist.
- **B2-D2. Who writes the first text.**
  - **Recommendation:** I draft each entry in plain words. It ships as `draft`, and the screen shows "Draft: not yet reviewed by a
    pharmacist." on it. You then rewrite and sign each one in context.
  - **Alternative:** the glossary ships with no entries until you write them. Terms then stay plain text.
- **B2-D3. How it opens.** **Recommendation:** from the word itself, into the side drawer the app already uses, plus an ⓘ for the full
  list. The alternative is a separate glossary page.
- **B2-D4. "Record a decision" where decisions are on.** **Recommendation:** a link to the result in the results list, where the existing,
  tested decision form is. The alternative is a second copy of the form inside the profile.
- **B2-D5. Scope on profile results.** **Recommendation:** yes, the small optional API field, so the label is right on every row.
- **G3 and P-D6, still open.** The screen's wording and the notice's wording. B2-D2 adds the glossary text to that list.

## Touched

| Path | Change |
| --- | --- |
| `packages/help-content/` (new) | `glossary.en.json`, its schema and tests, the package wiring |
| `packages/shared-types/src/genomic-profile.ts` | Optional `scope` on `genomicCheckResultSchema` |
| `apps/backend/src/genomic-profile/genomic-profile.builder.ts` and its spec | Copy each evaluation's `scope` onto its matching results |
| `apps/frontend/src/components/patients/` | A term button, the glossary drawer and its list, the decision control, the label on the row (one component per file) |
| `apps/frontend/src/lib/genomicProfileWords.ts` | The new fixed strings (draft) |
| `apps/frontend/e2e/genomic-profile.spec.ts` (new) | Section 5 |
| `GenomicProfileSection.test.tsx` | Unit tests for the glossary, the decision control and the label |
| `docs/clinical-validation/genomic-profile-read.md`, one status fragment | The claims and their tests |

## Not touched

- No route, role, migration, setting, knowledge file or Terraform change.
- Decisions stay off on staging, and switching them on stays direction plan F4.
- No help assistant: A3 is its own slice, and it will read `packages/help-content`.
- No Spanish (section 6).

## 6. Spanish

Every fixed string of the screen and every glossary entry stays in English, in the two files named above, until you write the Spanish.
When it exists, one small slice adds `glossary.es.json` and the Spanish strings beside the English ones, and follows the app's language
control. It is not machine translated, as `plan-slice-b.md` section 9 says.

## How it will be verified

As for N1 to N3: the code is written here and **not run here** (founder decision P2), and CI is the first run. That includes the new
browser tests, which run in CI's `browser` job. The defect injections stay on the open list with the earlier slices'.
