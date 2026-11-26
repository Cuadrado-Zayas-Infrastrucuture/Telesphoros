# Feature Specification: Help becomes a chat, and a model answers in it (A4)

**Created**: 2026-11-26

**Status**: **Specification only, waiting for the founder's decisions (section 7).** No code, route, setting, migration or Terraform change.

**Input**: The founder, 2026-11-26: "I saw that chat was completely eliminated, I think it would be good if that same chat could be used for user
assistance." Asked where and how, the founder chose:
- **Where:** Help becomes the chat, in the drawer opened from the sidebar on every page. The home stays a worklist (spec 052 RC-1 stands).
- **How:** a model answers. This is slice A4 of the direction plan.

Read with: [the direction plan](../../docs/design/plans/pharmacist-first-product-direction.md) N3, N4, sections 5 and 6 and F1;
[spec 051](../051-help-assistant/spec.md) (Help as built); [spec 052](../052-retire-the-chat/spec.md) (the chat retired);
[spec 003](../003-llm-harness/spec.md) (the model harness, a draft); [AI safety R1 to R5](../../docs/ai-safety-and-hallucination-controls.md).

## 1. What changes for the person using it

Today Help is a search box with a list. After this spec it is a conversation in the same drawer:

- The person types a question and presses Enter. It shows as their message.
- The answer shows below it as Help's message. It is a few sentences in plain words, each paragraph naming the article it comes from, with
  that article's links to screens.
- They can ask again. Earlier messages stay in the drawer until it is closed or the tab reloads. Nothing is kept after that (section 4).
- A question about a patient still gets the fixed refusal sentence, decided before anything else runs (spec 051 section 5). On a patient's
  page, the answer links to that patient's results.
- When nothing answers well, Help says so and offers the closest articles. It never guesses.

Help remains what N3 says it is: it explains the product. It never answers a clinical question about a patient, never takes an action, and
reads no patient record, report or clinical API.

## 2. Two parts, built in order

| Part | What answers | Needs | Can ship |
| --- | --- | --- | --- |
| **C1, the chat** | The engine Help has today: reviewed articles and the glossary, matched with no model (N4). An answer is the best article's own text, quoted, with its links | Nothing new: frontend only | Now |
| **C2 to C4, the model (A4)** | A model writes the answer from the matching articles and cites them. A code check confirms every sentence is backed by a cited passage. When the check fails, the model is off, failing or over budget, the C1 answer shows instead | The gates in section 5 and the decisions in section 7 | Only after the gates pass |

C1 first means the chat is usable at once, and the model has a working fallback from its first day. The model never removes the curated
answer; it is an added way of saying the same reviewed content.

## 3. What the model may do

- **Its only source** is the help corpus: the articles, the glossary, the refusal sentence and the screen and role names. It never sees
  patient data, reports, results or anything from the clinical API. A test asserts the request carries nothing else.
- **What it writes** are short answers in the reader's language, each sentence citing an article id and passage.
- **The citation check is code.** Every cited passage must exist in the corpus and support the sentence by an agreed rule (section 7,
  HC-D5). A sentence that fails is removed; if too little is left, the whole model answer is withheld and the C1 answer shows.
- **The refusal comes first and is deterministic** (spec 051 H-D6). The model adds its own refusal check after it, and never replaces it
  (direction plan section 5).
- **Labelled as assistant output** (R4): "Written by an assistant from the articles below. Draft articles are not yet reviewed."
- **No actions** (tier T0): it may link to a screen, and never does anything.

## 4. Data, storage and spend

- **The typed text may hold patient information,** whatever the rules say, because people type what they type. R1 says "when unsure, the
  class is `phi`". That is decision F1 (section 7, HC-D1).
- **Nothing typed or answered is stored** beyond the open drawer (R5, and the direction plan's default). There are no logs of text. Topic
  counts, if spec 051 H3 is ever built, count articles opened, never text.
- **Hosting and spend** are decision AG-D7 (section 7, HC-D2). Nothing is approved yet. An agent session never applies Terraform or sets keys
  (agent policy); the founder does both.
- **The model path is dormant** until the founder turns it on (spec 003 story 7): a server switch, off by default, with a rehearsed kill
  switch like `ASSESSMENT-OFF`.

## 5. Gates before any model answer reaches a person (direction plan section 6)

| Gate | Met when |
| --- | --- |
| R1, data class | F1 decided and a test holds it: the request to the model carries only the corpus, the question and the screen and role names |
| R2, guards on the serving path | The refusal rule and the citation check both run on the path people use, each proved by a deliberately broken test that goes red |
| R3, evaluation before change | A fixed question set runs as a required check on every pull request touching the prompt, model or decoding, in each language offered. It includes questions that must be refused and articles with injected instructions |
| R4, labelled output | The label in section 3 shows on every model answer, and a withheld answer falls back without an error |
| R5, retention | No text is stored; a test asserts nothing typed reaches a log or a table |
| Hosting and spend | AG-D7 decided, budgets set, the switch off by default, the kill switch rehearsed |
| Articles signed | The articles the model answers from are signed by two pharmacists (spec 051 H-D1). A draft article can still be quoted by C1 with its draft line, but the model answers only from signed ones (HC-D4) |

## 6. Slices

| Slice | What | Touches | Waits for |
| --- | --- | --- | --- |
| **C1** | The Help drawer as a conversation over today's engine: the person's message, Help's answer (the best article's text and links, or the refusal, or "no good match" with the closest three), Enter to send, a scrolling history cleared on close. Unit and browser tests; the existing Help tests carried over | `apps/frontend` | Nothing |
| **C2** | The model path in `apps/ai-service`, dormant: the corpus-only request, the citation check, the fallback, the label, the evaluation set as a required check. No host; a fake model in tests | `apps/ai-service`, CI | C1, HC-D3, HC-D5, spec 003 approved or amended for the help lane |
| **C3** | One backend route that sends the question to the ai-service and returns the answer or the fallback, behind the switch, off everywhere | `apps/backend` | C2, HC-D1 |
| **C4** | The host: the chosen model, budgets, kill switch, applied by the founder | Terraform, `docs/ops` | C3, HC-D2, the BAA if HC-D1 is `phi` and real use is wanted |

Each slice gets its own plan and PR, as before.

## 7. Decisions for the founder

- **HC-D1 (F1). The data class of what people type.**
  - **Recommended:** `phi`. The model runs only inside the platform's boundary, and real use waits for the AWS BAA. Until then, staging
    is synthetic only, as it is today.
  - **Alternative:** `no-phi`, with a pre-check that refuses text that looks like patient information. The pre-check cannot be complete,
    and R1 says "when unsure, `phi`".
- **HC-D2 (AG-D7). Where the model runs.**
  - **Recommended:** Amazon Bedrock in the existing AWS account and region. It stays inside the boundary that `phi` needs, and no servers
    run for it. The model and budgets are set in C4.
  - **Alternative:** a self-hosted open-weight model. This means more control and more work: servers, scaling and updates.
- **HC-D3. Which languages the model answers in first.**
  - **Recommended:** English first. The Spanish articles do not exist yet (spec 050), and the evaluation needs a set in each language
    offered.
  - **Alternative:** both languages, after the Spanish articles exist.
- **HC-D4. Draft articles.**
  - **Recommended:** the model answers only from signed articles. C1 keeps quoting drafts with their draft line, as Help does now.
  - **Alternative:** it answers from drafts too, labelled as drafts. This is faster to try, but the model would be rephrasing unreviewed text.
- **HC-D5. How strict the citation check is.**
  - **Recommended:** every sentence must cite a passage, and the words that carry the meaning (feature names, statuses, roles, numbers)
    must appear in that passage. It is simple, mechanical and testable. Anything looser needs a second model as a judge, which R2 says
    cannot be the only guard.
  - **Alternative:** a judge model scores support, with the mechanical rule kept as the floor.
- **HC-D6. Spec 003.** Spec 003 is the harness for a model that explains engine results (the clinical lane). It is still a draft.
  - **Recommended:** amend spec 003 with a help lane that reuses its harness parts (budgets, switch, evaluation gate) without the
    clinical evidence rules. Approve that before C2.
  - **Alternative:** a separate, smaller harness spec for help only.

## 8. What does not change

- The refusal rule and its sentence (spec 051).
- The home: no box for typed questions (spec 052 RC-1).
- No patient data reaches Help or the model.
- No model, host, key or spend exists until C4 is approved and applied by the founder.
