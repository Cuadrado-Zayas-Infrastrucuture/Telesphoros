# Plan: spec 053, slice C1, the Help drawer as a conversation

**Status**: **approved by the founder on 2026-11-26: C1-D1 and C1-D2 as recommended (section 6).** Plan only: no code or test changes. Read against `main` at
`305548a3`, after #501 (spec 053). The code goes in the pull request after the one that merges this plan.

C1 turns the Help drawer into a chat over the engine Help has today: the reviewed articles and the glossary, matched with no model (spec
053 section 2). It touches `apps/frontend` only. Nothing is sent, stored or read from a patient record, exactly as now.

## 1. What Help is today

Read on `main`:
- **`components/help/HelpButton.tsx`** opens the drawer from the sidebar on every signed-in page. It loads the panel the first time it is
  opened, and then **keeps it mounted**, so it opens again at once.
- **`components/help/HelpPanel.tsx`**, in the shared `ContextDrawer` (a native modal dialog that returns focus when it closes):
  - a search box that searches **as the person types**;
  - "For this page" (this screen's articles for these roles) before anything is typed;
  - a results list, with "No article answers that exactly. These are the closest:" and three suggestions for a weak match;
  - the fixed refusal for a question about a patient, decided before any search, with a link to the patient's results on a patient page;
  - a click on a result opens the article in place, with **Back to the articles**.
- **`lib/helpSearch.ts`**: `searchHelp`, `isPatientQuestion`, `articlesFor`, `helpScreenOf`. These are pure functions, and they are tested.
- **`lib/helpWords.ts`**: the panel's own fixed words (English).
- **Tests:** `HelpPanel.test.tsx` (9) and `e2e/help-panel.spec.ts` (5, at 375 and 1280 px, light and dark, by keyboard).

## 2. What changes on screen

The drawer keeps its title, its place and how it opens and closes. Inside it:

1. **Before anything is asked**, the drawer shows one short line, "Ask how something in the app works.", and under it **For this page**,
   the same articles as now, as buttons.
2. **A box at the bottom**, labelled **Ask Help**, with a **Send** button. Enter sends; the box empties and keeps the focus. An empty or
   blank box sends nothing.
3. **What is asked shows as the person's message** ("You"), and **Help's answer under it** ("Help"). Help's answer is one of three:

   | When | Help's answer |
   | --- | --- |
   | `isPatientQuestion` is true | The refusal sentence, as now. On a patient's page, the link to that patient's results. No search runs |
   | `searchHelp` has a hit and the match is not weak | **The best article, quoted whole:** its title as "From: *title*", its paragraphs, its links to screens, and its foot (the draft line or who signed it). A glossary word is quoted the same way, as "Word: *term*". Under it, **Also in Help**, up to two more hits as buttons |
   | The match is weak, or nothing matches | "No article answers that exactly. These are the closest:" and the three closest, as buttons (this page's first three when nothing matches at all, as now) |

4. **A suggestion button** (For this page, Also in Help, or the closest three) adds Help's answer for that article to the conversation,
   with no "You" message above it (C1-D1).
5. **The conversation scrolls**; the newest answer is brought into view. It is kept while the drawer is open, and **cleared when the
   drawer closes** (spec 053 section 1). The panel stays mounted after its first opening, so closing must empty it in code; reloading the
   tab empties it anyway.
6. **At most 20 exchanges** are kept on screen. The oldest goes first (C1-D2).

Help says the same things as now: the same articles, glossary, refusal and weak-match sentence. Only the shape is new.

**Search no longer runs as the person types.** Spec 053 section 1 says the person "presses Enter". A list that changes with every letter
does not fit a conversation, and it would put a half-typed question into the history.

## 3. How it is built

- **`lib/helpConversation.ts` (new, pure):** `answerFor(question, screen, roles, pathname)` returns the answer for one question, as data:
  `{ kind: 'refusal', patientLink?: string }`, `{ kind: 'quote', hit, more: HelpHit[] }` or `{ kind: 'closest', hits: HelpHit[] }`. It calls
  `isPatientQuestion` first and `searchHelp` only if that is false. `answerFor` is the one place the rule order lives, so C2's model
  path can call the same function for its fallback.
- **`HelpPanel.tsx`:** holds the exchanges in component state (`{ id, asked?: string, answer }[]`); nothing goes to storage, the URL or
  the network. `HelpAnswer` and `HelpQuote` (new, in `components/help/`) draw one answer and one quoted article. The quoted article reuses the
  paragraphs, links and foot from the article view, which goes away.
- **`HelpButton.tsx`:** unchanged. The panel empties itself in its own close handler, which Escape and the close button both reach
  (point 5 above).
- **`lib/helpWords.ts`:** the new fixed words. These are "Ask how something in the app works.", "Ask Help", "Send", "You", "Help", "From:",
  "Also in Help" and "Earlier messages are removed after 20." `search`, `hint`, `results` and `back` go. The words stay English, like the
  rest of Help (spec 053 HC-D3).

**Accessibility:**
- The conversation is a list (`role="log"`, named "Conversation with Help"), so a screen reader announces each new answer once, politely.
- Each message is a list item named by who wrote it.
- Focus stays in the box after sending. After a suggestion button is used, the focus moves to the new answer's heading.
- Escape closes the drawer and returns focus to Help, as now.
- Every control is a 44 px target, and there is no sideways scroll at 320 px.

## 4. Tests (working agreement 6)

`lib/helpConversation.test.ts` (new), with expectations written by hand from spec 051 sections 4 and 5:
- a patient question gives the refusal, and `searchHelp` is never called (a spy), on a patient's page and elsewhere;
- "what is a held result" quotes `held-results`, with up to two more hits;
- "phenotype" quotes the glossary word;
- "zebra" gives the closest three, and so does a question of filler words only;
- the over-refusal cases spec 051 lists ("what is a held result", "how do I add a patient", "what does phenotype mean") are answered, not
  refused.

`HelpPanel.test.tsx`, rewritten. Its nine cases carry over, plus:
- **Sending:** Enter and Send both send; a blank box sends nothing; the box empties and keeps the focus.
- **The conversation:**
  - two questions give two exchanges, in order;
  - a suggestion adds an answer;
  - closing and reopening shows an empty conversation;
  - the 21st exchange removes the first.
- **Nothing leaves the browser:** nothing is sent and nothing stored while asking, including a refused question (as the current test).
- **Accessibility:** no WCAG A/AA violation, empty and with three exchanges.

`e2e/help-panel.spec.ts`, rewritten to the conversation:
- the five tests keep their purpose: themes and widths, 44 px targets, keyboard, the refusal, and no request;
- the keyboard test becomes: open Help, type, Enter, the quoted answer is visible, Escape returns focus to Help;
- one new test: three exchanges at 375 px, with the newest in view and no sideways scroll.

**Unchanged:**
- `helpSearch.test.ts` (the engine does not change);
- `help.test.ts` and `glossary.test.ts` (the content does not change);
- the sidebar and route tests, which look only for the Help button.

**Deliberately broken check, before the PR is opened:** make `answerFor` search before the refusal, and the refusal test goes red. This is
reported in "How it was verified", then reverted.

## 5. Also in the code PR

- `docs/start-here.md`: its Help line says you can ask Help a question.
- `docs/design/clinical-workspace-usability-protocol.md`, task 2 is unchanged. It already says "reads its answer".
- One status fragment.

**Not in C1:**
- any model, route or setting (C2 to C4);
- topic counts (spec 051 H3);
- Spanish;
- the home page (spec 052 RC-1 stands).

## 6. Decisions for the founder

- **C1-D1. What a suggestion button does.** **Decided 2026-11-26: as recommended.**
  - **Recommended:** it adds Help's answer for that article to the conversation, with no "You" message above it, because the person did
    not type anything. Everything stays in one place, and the conversation shows what was read.
  - **Alternative:** it opens the article over the conversation, with **Back to the conversation**, as the article view does now. This is
    closer to today, but it puts two ways of reading in one drawer.
- **C1-D2. How much of the conversation is kept while the drawer is open.** **Decided 2026-11-26: as recommended (the last 20).**
  - **Recommended:** the last 20 exchanges, with the line "Earlier messages are removed after 20." This keeps the drawer quick on a phone,
    and 20 is more than a person asks in one sitting.
  - **Alternative:** no limit until the drawer closes.

## 7. How this plan was checked

Read from `main` at `305548a3`:
- `HelpPanel.tsx`, `HelpButton.tsx` and `HelpPanel.test.tsx`;
- `ContextDrawer.tsx`;
- `lib/helpSearch.ts` and `lib/helpWords.ts`;
- `e2e/help-panel.spec.ts`;
- the Help references in `WorkspaceSidebar.test.tsx` and `routes.test.tsx`;
- spec 051 sections 4 and 5, and spec 053.

No code ran.
