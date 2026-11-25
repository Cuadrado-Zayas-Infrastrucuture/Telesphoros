# Plan: the landing page says what the app is now (landing copy refresh)

Date: 2026-11-25

Status: **approved by the founder on 2026-11-25: LC-D1 and LC-D2 as recommended, LC-D3 as the alternative (the English first).** Plan only: no copy, code or test changes.

## 1. Why

The public landing page (`apps/frontend/src/lib/landing/landing-copy.ts`, refreshed 2026-10-31) still describes the app as it was then: a
chat home with every feature in a side panel. Since then the worklist became the home (spec 049), Help arrived (spec 051), the chat was
retired (spec 052) and the patient list searches every patient (spec 040). A visitor who signs in after reading the page finds none of
what it promised. Nothing on the page is unsafe; it is out of date.

## 2. What is out of date (English)

| Entry | Says now | Why it is out of date |
| --- | --- | --- |
| `purpose.today` | "…a chat home that shows each report's status." | The home is the worklist (spec 049) |
| `capabilities.intro` | "A chat home with every feature in a side panel, …" | No chat; features are pages, not a panel (specs 041, 052) |
| `capabilities.rows[0].text` | "…add one by label from the side panel, then attach a structured JSON report." | Patients are added on the Patients page; reports on Attach a report |
| `capabilities.rows[1].text` | "Past reports sit in the side panel … All reports lists every report …" | Recents sit in the sidebar; the page is called Reports |
| `capabilities.rows[2]` | "Start from the chat. After you sign in, the chat is your home. … A typed question gets a note, not an answer." | The chat is gone |
| `fragments.question`, `fragments.answer` | The chat sample: "What does this report show?" / "Interpretation is not available in the prototype yet." | The decorative fragment shows a chat that no longer exists |
| `questions.items[4]` | "Does the chat interpret my reports?" / "…the chat uploads a report and shows its status…" | Same |

Unchanged on purpose: every boundary statement (synthetic data only, not for clinical use, no medication or dose advice, verification is
storage and not clinical review), the hero, the purpose paragraphs, the other four questions and the closing. `landing-copy.test.ts` keeps
the boundary statements in both languages; this plan does not touch them.

## 3. Proposed English

| Entry | Proposed |
| --- | --- |
| `purpose.today` | "The prototype starts with patient-linked reports, verified file storage and a worklist home that shows what needs a person today. Clinical interpretation and prescribing recommendations are not available yet." |
| `capabilities.intro` | "A worklist home, a patient list you can search, patient-linked intake and a status for every file." |
| `capabilities.rows[0].text` | "Find a synthetic patient by label, or add one on the Patients page, then attach a structured JSON report on Attach a report. Raw genomic files are not accepted." |
| `capabilities.rows[1].text` | "Recent reports sit in the sidebar with their status. The Reports page lists every report you can see, with its format and upload status." |
| `capabilities.rows[2].title` | "Start from your worklist." |
| `capabilities.rows[2].text` | "After you sign in, your home is a worklist: the follow-ups assigned to you and the results that are held. Help, in the sidebar, explains each page in plain words." |
| `capabilities.rows[2].note` | "No live AI or prescribing recommendations." (unchanged) |
| `fragments.question` / `answer` | As LC-D2 decides |
| `questions.items[4].q` | "Does Help answer questions about a patient?" |
| `questions.items[4].a` | "No. Help explains how to use the app, from reviewed articles. A question about a patient gets a fixed sentence pointing to that patient's results, never an answer." |

The last answer describes Help's refusal rule as built (spec 051, section 5). It promises no interpretation.

## 4. Decisions for the founder

- **LC-D1. What "Where we are today" claims about interpretation.** **Decided 2026-11-25: as recommended.**
  - **Recommended:** keep "Clinical interpretation and prescribing recommendations are not available yet." as it is. The genomic
    profile and medication check (spec 044) run on synthetic data behind the clinical hold. Saying more on a public page is a claim for
    the founders and counsel, not a copy fix.
  - **Alternative:** add one sentence on the genomic profile, with its hold, in words the founders write.
- **LC-D2. The decorative fragment beside the third row** (`AssistantFragment.tsx`, now a chat exchange). **Decided 2026-11-25: as recommended.**
  - **Recommended:** a Help exchange that asks how to do something in the app. Question: "How do I attach a report?" Answer: "Choose
    Attach a report on your home page." It is about the app, never about a patient, and it is what Help really answers.
  - **Alternative:** a still worklist fragment: two rows, "Follow-up due today" and "Result held", with no exchange.
- **LC-D3. The Spanish.** The landing's Spanish is the founders' draft (spec 050 LS2-D6 has them review it rather than rewrite it), and
  machine translation is ruled out (spec 050 R7). **Decided 2026-11-25: the alternative, the English first.**
  - **Recommended:** one PR with the English above and the founders' Spanish for the same seven entries. It merges only once the
    Spanish is in. Until then the PR waits as a draft with the Spanish rows marked.
  - **Alternative:** the English first, with the Spanish rows left as they are until the founders rewrite them. For a while the two
    languages would describe different apps.

## 5. The slice (one PR)

- `lib/landing/landing-copy.ts`: the entries in section 2, in English. The Spanish rows stay as they are (LC-D3), each marked in a comment as
  waiting for the founders' rewrite, and listed in the PR.
- `components/landing/AssistantFragment.tsx`: per LC-D2. Its comment no longer names the chat.
- `components/landing/LandingActions.tsx`: its comment says the signed-in home is the worklist, not the chat.
- Tests:
  - `landing-copy.test.ts`: the check that "quotes the chat note exactly" becomes a check of the new fragment's words;
  - `e2e/landing.spec.ts`: the FAQ case opens the new question; the fragment case reads the new answer;
  - `e2e/landing-language.spec.ts`: its list of English headings that must not show in Spanish gains "Start from your worklist".

No other page, word table or test changes. Boundary statements and their tests are unchanged.

## 6. How this was checked

Read from `main` after #481: `landing-copy.ts`, `AssistantFragment.tsx`, `LandingActions.tsx`, `landing-copy.test.ts`,
`e2e/landing.spec.ts`, `e2e/landing-language.spec.ts`. The worklist wording is taken from `HomeFollowups.tsx`, `HomeHeldResults.tsx` and the
draft Help article "What the home page shows". No code ran.
