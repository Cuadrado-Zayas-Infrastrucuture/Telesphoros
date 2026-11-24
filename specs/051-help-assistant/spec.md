# Feature Specification: the help assistant, curated (direction plan slice A3) (HA)

**Feature Branch**: `claude/051-help-assistant-spec` (this specification); each slice its own branch and pull request off `main`

**Created**: 2026-11-24

**Status**: **draft, awaiting the founder's approval of H-D1 to H-D6 (section 8). Specification only: no code, route, setting, migration
or knowledge change.** It carries out slice A3 of [the pharmacist-first direction plan](../../docs/design/plans/pharmacist-first-product-direction.md):
decisions N3 ("chat is the product's help assistant … never the clinical interface") and N4 ("curated answers first, no model"). It answers
the plan's open decisions F2 (who writes the help) and F3 (which policies it may quote) as H-D1 and H-D2. A model is slice A4 and is not here.

The founder's direction bounds every choice: **clear to a prescriber or pharmacist with no PGx background, and simple and enjoyable to work
with.** For help, that means: from any screen, one click opens short answers about that screen in plain words, typing a few words finds the
rest, and a question about a patient is pointed to the patient's page instead of being answered.

## 1. What is there today (read from `main` at `64253c3`, 2026-11-24)

- **No help exists.** The chat at `/chat` (spec 049 W-D2) attaches reports; a typed question gets "Questions cannot be answered here."
  (specs 024 D3, 038 D3).
- **The glossary exists** in `packages/help-content` (spec 044 B2-D1): `glossary.en.json` with a strict schema, a `draft`/`signed` status
  that needs two named pharmacists and a date, and a test that refuses a signed entry with fewer. The genomic profile opens it in the side
  drawer (`ContextDrawer`). The package was made so "the screen and the assistant can never say different things".
- **The app is English only.** Spec 050 (approved 2026-11-24) builds the language layer; it leaves "the assistant's explanations" out.
- **Policies:** `docs/legal/privacy-policy-draft.md` is a draft. Nothing is published.
- **Screens and roles are known on the client:** the route (`useLocation`) and `useAuth().roles`.

## 2. What A3 does

1. **A Help panel, from every signed-in page.** A "Help" button in the sidebar opens the existing side drawer. It is not the home and
   never covers the work for good: Escape closes it and focus returns to the button.
2. **It opens on the articles for this screen and this role.** For example, on the worklist: "What the worklist shows", "What a held
   result means". A role that cannot use a feature is not shown its how-to, and an article about a control that is off here says so.
3. **Search as you type, in the reader's language.** Every article and every glossary entry is searched, with no model. A weak match says
   so and offers the closest articles, and never guesses.
4. **Questions about a patient are refused by a fixed, tested rule** (section 5). The answer is a fixed sentence and a link to the
   patient's page, where the result and its evidence are.
5. **Nothing about a patient is read or written.** The panel reads only the articles, the glossary, the current screen's name and the
   person's roles. Typed text is never sent anywhere and never stored. Counting topics is H-D3.

## 3. The articles (`packages/help-content`)

- **Format.** One JSON file per language, `help.en.json` and `help.es.json`, with a strict zod schema like the glossary's:

  ```
  { id, title, body: [paragraph], screens: [route id], roles: [role] | "all", keywords: [string],
    links: [{ label, to }], status: "draft" | "signed", signedBy: [{ name, role, date }] }
  ```

  `body` is plain paragraphs: no markup, and no link except through `links`, whose `to` must be an app route. A test refuses an unknown
  route, a signed entry with fewer than two signers, and a `draft` entry that names any.
- **What an article may say.** How the product works, what a screen, status or reason code means in general, and why a control is
  unavailable to a role or in this environment. It never says anything about a patient, never recommends a drug, dose or action, and never
  says "safe", "no interaction", "not affected" or "none". The same test that guards the screens checks this.
- **The first articles, English (H-D1).** About twelve, each a few sentences:
  - the worklist;
  - held results;
  - follow-ups;
  - finding and adding a patient;
  - attaching a report;
  - the genomic profile;
  - the phenoconversion notice;
  - recording a decision, and why it is off on staging;
  - roles: reader, clinician, reviewer and administrator;
  - synthetic data only and not for clinical use;
  - the words used on the screens, pointing to the glossary;
  - where the policies are (H-D2).
- **Spanish** is written by the founders, not translated by a machine (spec 050). It appears when spec 050's language layer lets a person
  choose Spanish. Until then the Spanish file may be empty, and a test checks that every Spanish article has an English one with the same
  `id`.

## 4. Search (no model)

- Text is matched against `title`, `keywords` and `body` in the reader's language. Accents, letter case and repeated spaces are ignored,
  and so are a fixed list of filler words ("the", "how", "do", "el", "cómo", …).
- The score is the number of matched words, with title and keyword matches weighted above body matches. Results are listed by score, then
  by the screen's own articles first, then alphabetically. The order is fixed and tested.
- If the best result matches fewer than half the question's words, the panel says "No article answers that exactly. These are the
  closest:" and lists the three nearest. It never shows a made-up answer.
- Glossary entries appear in the same results, marked as words.

## 5. The rule for patient questions (deterministic, tested)

The panel never sees patient data, so it cannot answer about a patient. A general article shown in reply to "what should I give SYN-0042?"
would still read as an answer. So before searching, typed text is checked against fixed signals:

| Signal | Example |
| --- | --- |
| A patient label pattern | `SYN-0042` |
| A star allele, diplotype or activity score | `*2/*2`, `CYP2C19*17`, `activity score 1.5` |
| A patient word with a clinical word, in English or Spanish | "my patient … dose", "este paciente … medicamento", "should she take …" |
| A drug name from the bundled list together with a patient word | "can my patient take clopidogrel" |

On a match, the panel searches nothing and shows a fixed sentence (draft, the founders' to sign as part of H-D1):

> "Help explains how the product works. It does not answer questions about a patient. Open the patient's page to see their results and
> where each one comes from."

When the screen is a patient's page, the sentence ends with a link to that page's results. The rule is tested with a list of questions
that must be refused and a list that must not: "what is a held result", "how do I add a patient" and "what does phenotype mean" must still
be answered. It can over-refuse, but it is never the only safeguard, because no article speaks about a patient.

## 6. Slices

| Slice | What | Touches |
| --- | --- | --- |
| **H1, the articles** | The article schema and its tests, `help.en.json` with the first drafts, an empty `help.es.json`, and the route ids the articles may name | `packages/help-content` only |
| **H2, the panel** | The Help button, the drawer, the screen and role context, search, the patient-question rule, unit tests and a browser test | `apps/frontend` only |
| **H3, topic counts** (if H-D3 says now) | A count per article opened and per "no match", never the text, through one write route | backend, a migration, frontend |

## 7. Not touched

- No model, host, spend or key (A4). The A4 gates in the direction plan section 6 do not apply here.
- No patient data is read, no clinical logic, and no recommendation.
- The chat stays as it is (H-D5).
- Spec 050's language layer: A3 uses it when it exists and builds no language choice of its own.
- No policy text until it is published (H-D2).

## 8. Decisions for the founder

- **H-D1 (F2). Who writes the articles.**
  - **Recommended:** I draft the English articles and the refusal sentence in plain words. They ship as `draft`, and the panel shows
    "Draft: not yet reviewed by a pharmacist." on each. You rewrite and sign them. The founders write the Spanish (spec 050), and nothing
    is machine translated. This is how the glossary was done (B2-D2).
  - **Alternative:** the panel ships with no articles until you write them, and shows only the glossary.
- **H-D2 (F3). Which policies it may quote.**
  - **Recommended:** none until you and counsel publish them. The "where the policies are" article says they are not yet published, and
    the draft privacy policy is never quoted.
  - **Alternative:** quote the draft, marked as a draft.
- **H-D3. Counting what people ask.** The direction plan wants topic counts as the proof of concept's evidence.
  - **Recommended:** a later slice, H3. It needs a write route, a table and a privacy review of its own, and the usability sessions (F5)
    can judge the panel first.
  - **Alternative:** in A3 now.
- **H-D4. Where Help opens.**
  - **Recommended:** a Help button in the sidebar on every signed-in page, opening the side drawer, which also holds the glossary.
  - **Alternative:** a floating button in a corner of every page.
- **H-D5. The chat.**
  - **Recommended:** unchanged in A3. It still attaches reports, and retiring it is its own slice once attaching has a home outside the
    chat (spec 049 noted that attach still lives there).
  - **Alternative:** send the chat's typed questions to Help now, which would end "Questions cannot be answered here."
- **H-D6. The patient-question rule.**
  - **Recommended:** as section 5, refusing before searching, with a must-refuse list and a must-answer list as its tests.
  - **Alternative:** no rule, relying on the articles saying nothing about a patient.

## 9. Tests (working agreement 6)

- **H1:**
  - the schema rejects bad entries (signers, routes, markup, links outside `links`);
  - no article contains "safe", "no interaction", "not affected" or "none";
  - every Spanish `id` has an English twin;
  - every `screens` id is a real route.
- **H2, unit:**
  - the articles for each screen and role;
  - search: its order and its weak-match sentence, from hand-written expectations;
  - the refusal rule, against the must-refuse and must-answer lists;
  - nothing typed is sent (no request while typing or searching), and nothing is stored;
  - Escape and focus;
  - the draft line.
- **H2, browser:** the drawer at 375 and 1280 px, light and dark, by keyboard, with 44 px targets and no axe violation.
- **Defect injections:**
  - a patient question that is searched;
  - a request made while typing;
  - an article shown to a role it excludes;
  - a weak match shown as an answer.

  Each must fail a test.
- **Usability (the founders, with a non-specialist):** "Find out from the product what a held result is, and then ask it about this
  patient's clopidogrel." It passes when the participant finds the article and is pointed to the patient's page for the second question.

## 10. How it will be verified

As for spec 049: the code is written here and **not run here** (founder decision P2), and CI is the first run. A pull request is marked
ready before CI runs (drafts skip it). The defect injections join the open list.
