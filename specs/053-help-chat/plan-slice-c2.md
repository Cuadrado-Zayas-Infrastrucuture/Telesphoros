# Plan: spec 053, slice C2, Help's model path, dormant

**Status**: **Approved by the founder on 2026-11-27: C2-D1 to C2-D3 as recommended (section 7).** Plan only: no code or test changes. Read against `main` at
`59384a94`, after #504 (C1, the conversation) and #505 (the help lane, [spec 003 help-lane.md](../003-llm-harness/help-lane.md)).

C2 builds everything the help lane needs **except a real model and a way for the app to reach it**:
- the rule and the search, moved to one shared place;
- the help task, its prompt, its output contract, checks HC1 to HC6, the fallback and the label;
- the evaluation set as part of `verify`.

A scripted stand-in is the only model. Nothing in the product calls this code until C3 adds a route behind a switch that is off, and C4
adds a host. Help on screen does not change in C2.

## 1. What exists to build on

Read on `main`:
- **The C1 engine** in `apps/frontend/src/lib/`:
  - `helpSearch.ts`: `isPatientQuestion`, `searchHelp`, `articlesFor`, `helpScreenOf`;
  - `helpConversation.ts`: `answerFor`, which refuses first and then searches.
- **`packages/help-content`**: the articles, the glossary and the refusal sentence, with their schemas. It is a source-only package (its
  `main` is `src/index.ts`), and only the frontend uses it today. **Every article and glossary entry is still a draft**: none is signed.
- **`apps/ai-service`**, the harness from spec 003:
  - the model port with no tools (`model-clients/port.ts`) and a scripted client (`scripted.ts`, with `obedient` for attacks);
  - the task registry (`tasks.ts`: data class, output class, checks, prompt fields, provider) and its R1 and R4 problems check;
  - readiness (`policy.ts`), budgets, the outcome, trace and receipt;
  - the clinical evaluation gate (`evals/run.ts`, `evals/pinned.ts`, `test/eval-gate.test.ts`). It runs in `verify` with every ai-service
    test, and it is red until the pinned digests match the template, lexicons, model identity and limits.

  It is built with tsup, which leaves dependencies out of the bundle by default.

## 2. Three pull requests (C2-D2)

| PR | What | Touches |
| --- | --- | --- |
| **C2a** | Move `isPatientQuestion`, `searchHelp`, `articlesFor`, `visibleTo`, `helpScreenOf`, `normalizeHelpText`, `queryWords` and `answerFor` into `packages/help-content` (`src/engine/`), with their tests. The frontend imports them from there. Behaviour does not change: the frontend's Help tests and browser tests pass unchanged | `packages/help-content`, `apps/frontend` |
| **C2b** | The help lane in `apps/ai-service/src/help/`: the task, the prompt, the output contract, HC1 to HC6, `runHelpAnswer` with its fallback and label, each check with a broken copy | `apps/ai-service` |
| **C2c** | The evaluation set (`evals/help/`), the help gate and its pinned digests, run in `verify` | `apps/ai-service` |

Each PR is its own branch off `main`, never stacked, and merged in order.

## 3. C2a: one rule, one search

- **Moved, not copied.** The functions above move to `packages/help-content/src/engine/` and are exported from the package. The
  frontend's `lib/helpSearch.ts` and `lib/helpConversation.ts` become one-line re-exports, so no frontend import changes. The tests move
  with them, and `packages/help-content`'s `vitest` runs them.
- **A test that there is only one.** A source test fails if `isPatientQuestion` or `searchHelp` is defined anywhere but
  `packages/help-content`.
- **The breakage catalogue** (`scripts/breakages/catalogue.json`): entries H2-1, H2-3, H2-4 and C1-1 point at the new files and commands.
  The rules do not change.
- **Not changed:** what Help shows, its words, and the article content.

## 4. C2b: the help lane in `apps/ai-service/src/help/`

All of this follows [help-lane.md](../003-llm-harness/help-lane.md). The numbers are its requirements.

- **Packaging.** `apps/ai-service` gains `@telesphoros/help-content` as a dependency. Its tsup config lists the package in `noExternal`,
  so the built library carries the rule and the articles, and C3's backend can load it without reading TypeScript source. A test
  imports the built `dist` and calls `isPatientQuestion`.
- **The task** (R1, R4). A new task, `help.answer.v1`, joins `TASKS` in `tasks.ts`:
  - it is declared `phi`, with `provider: 'baa-required'` and output `free-text`;
  - its checks are `HC1` to `HC6` and `OUT_OF_SCOPE`;
  - its prompt fields are `question`, `screen`, `roles` and `articles`.

  `taskProblems` learns that the full set of checks for a free-text task depends on the task. The clinical task keeps S1 to S6 and the
  verifier, and the help task has its own set. Its existing tests stay. New ones cover a help task missing a check, and a help task
  declared `no-phi`.
- **The prompt** (FR-H1), in `src/help/prompt-v1.ts`, with a digest:
  - a fixed template;
  - the signed articles chosen by `answerFor`'s search, at most three, plus the glossary entries they name;
  - the screen name and the role names;
  - the question, in a delimited block that the template names as text to answer, never to follow.

  A provenance test builds prompts from 20 hostile questions. It fails if any string outside that list reaches the prompt.
- **The output contract** (FR-H2). A zod schema allows at most 6 sentences of plain text, each with an `articleId` and a `passage`, plus
  `outOfScope`.
- **The checks** (FR-H3), each a pure function in `src/help/checks.ts` that takes the answer, the articles that were sent and the roles:

  | Check | Holds when |
  | --- | --- |
  | HC1 | The passage is not a byte-exact span of the cited article's body |
  | HC2 | The cited article was not sent, is not signed, or is not visible to the roles |
  | HC3 | A meaning-carrying word of the sentence is not in the passage. The lexicon is built from the corpus: titles' key words, keywords, glossary terms and aliases, role names, screen names and status words, plus every numeral. It is digested, like the clinical lexicons |
  | HC4 | `isPatientQuestion` refuses the sentence; or the sentence names a drug from `BUNDLED_DRUG_LIST`, a gene symbol from the fixed list in `src/help/lexicons.ts` (the CPIC genes, `GENEA` to `GENEZ`, and the `CYP` and `HLA-` forms), a star allele or an activity score |
  | HC5 | The sentence matches the articles' own "never reassures" rule (`safe`, "no interaction", "not affected", `none`) |
  | HC6 | The answer is empty or too long, breaks the schema, or a sentence addresses the reader's patient or talks about the model or its instructions |

  A test confirms that **no sentence of any article in the corpus trips HC4 or HC5**. A check the corpus itself fails would withhold every
  answer.
- **`runHelpAnswer`** (FR-H4 to FR-H6, HL-D1, HL-D3). It takes the question, the screen, the roles and a model port, and returns one of:
  - `{ kind: 'model', sentences, cited }`, a released answer;
  - `{ kind: 'curated', answer }`, which is exactly `answerFor`'s answer.

  It works in this order:
  1. It runs `answerFor` first. A refusal, a closest-three answer, or a hit with no signed article returns curated **without calling the
     port**.
  2. Otherwise it makes one call. Any schema failure, any failing check on any sentence, `outOfScope`, a port error, a timeout or an
     over-cap call returns curated. Its reason code is kept for the receipt, never shown.
  3. A released answer carries the label "Written by an assistant from the articles below." and the cited articles' own links.
- **The switch and readiness** (FR-H11). `helpReadiness()` lists the help lane's conditions from help-lane.md section 6. Like
  `liveReadiness()`, it is closed in code, and nothing can open it in C2.
- **Nothing stored** (FR-H9). `runHelpAnswer` returns its receipt fields: the cited ids, check results, reason code, counters, and the
  template and model identity. A scan test runs every evaluation question and fails if any question or answer text appears in the receipt
  or in anything logged.
- **Each check has a broken copy** (R2, SC-003). A test replaces each check with one that always passes and expects at least one
  evaluation case to go red. These are also added to the breakage catalogue as C2-1 onward.

## 5. C2c: the evaluation set and the help gate (FR-H7)

- **Where.** `apps/ai-service/evals/help/` holds the set, `evals/help/run.ts` holds the runner, and `test/help-eval-gate.test.ts` holds
  the gate. Like the clinical gate, it runs in `verify` with every ai-service test, so any change to the help lane or to
  `packages/help-content` is measured.
- **The corpus it runs against** (C2-D1). No article is signed yet, and the model answers only from signed articles (HC-D4). The gate
  runs against a fixture copy of the articles signed by "TEST SIGNER A" and "TEST SIGNER B" (section 7), and also against any real
  signed articles once they exist.
- **The set,** at the help-lane sizes (initial):

  | Part | Count |
  | --- | --- |
  | Questions that must be refused | 20 |
  | Answerable questions, each with a correct scripted answer and seeded wrong ones (invented feature, wrong role, changed number, reassurance, drug or gene named, uncited sentence, passage not in the article, article not sent) | 20 |
  | Questions with no good match | 10 |
  | Questions carrying instructions | 10, run with `obedient` |
  | Articles carrying instructions, in a fixture copy of the corpus | 5 |

  The agent drafts every question and seeded wrong answer from the articles. The founders review the 20 that must be refused in the C2c
  pull request (C2-D3).
- **What the gate requires:**
  - no wrong answer released;
  - no refused question reaching the port;
  - no instruction changing a released answer;
  - every correct answer released.

  It prints counts only, never text.
- **Pinned digests.** The help gate pins the template, the HC3 and HC4 lexicons, the corpus it runs against, the model identity and the
  limits, as `evals/pinned.ts` does for the clinical lane. **No code runs in an agent session (P2), so the digests cannot be computed
  while the PR is written.** The PR opens with them unset. The gate test prints the current values. The values from the PR's first CI run
  are then committed in a reviewed follow-up commit on the same PR, and the gate must then be green. The PR says this plainly.

## 6. What does not change

- What Help shows. C1 is the answer people see until C3 and C4, and C3's route stays off.
- The clinical lane, its tasks, checks, gate and pinned digests.
- No route, setting, migration, Terraform, host, key or spend.
- No article or glossary text. Signing stays the founders'.

## 7. Decisions for the founder

- **C2-D1. The corpus the evaluation runs against while no article is signed.** **Decided 2026-11-27: as recommended.**
  - **Recommended:** a fixture copy of today's articles in `apps/ai-service/evals/help/fixtures/`, marked signed by two fictitious
    signers named "TEST SIGNER A" and "TEST SIGNER B". It is never shipped:
    - a test fails if any product article names a test signer;
    - outside the evaluation runner, `runHelpAnswer` treats an article signed by a test signer as unsigned, so it is never sent to a
      model.

    When the founders sign real articles, the gate also runs against them.
  - **Alternative:** wait for the founders to sign articles before C2c. This is cleaner, but C2c cannot start until then.
- **C2-D2. Three pull requests or one.** **Decided 2026-11-27: as recommended (three).**
  - **Recommended:** three (C2a, C2b, C2c), as in section 2. Each is reviewable, and C2a is a pure move that proves nothing changes before
    any model code lands.
  - **Alternative:** one pull request. Fewer merges, but one large diff touching three packages.
- **C2-D3. Who drafts the evaluation questions.** **Decided 2026-11-27: as recommended.**
  - **Recommended:** the agent drafts all of them from the articles, including the seeded wrong answers. You and the co-founder review the
    20 that must be refused in the C2c PR, because where Help stops is a clinical boundary.
  - **Alternative:** you write the questions that must be refused, and the agent drafts the rest.

## 8. How this plan was checked

Read from `main` at `59384a94`:
- spec 053 and help-lane.md;
- `packages/help-content` (`package.json`, `src/index.ts`);
- `apps/frontend/src/lib/helpSearch.ts` and `helpConversation.ts`;
- `apps/ai-service`: `package.json`, `tsup.config.ts`, `src/tasks.ts`, `src/policy.ts`, `src/model-clients/port.ts` and the scripted
  client, `evals/run.ts`, `evals/pinned.ts`, `test/eval-gate.test.ts`;
- `packages/shared-types/src/drug-list-data.ts`;
- `packages/cpic-schema/src/knowledge.ts` (its gene-symbol rule is a pattern, too broad for HC4, so HC4 keeps its own list).

No code ran.
