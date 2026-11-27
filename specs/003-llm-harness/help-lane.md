# Amendment to spec 003: the help lane (spec 053, HC-D6)

**Created**: 2026-11-26

**Status**: **Approved by the founder on 2026-11-26: HL-D1 to HL-D3 as recommended (section 7).** Specification only: no code, route, setting, migration or
Terraform change. Spec 053 slice C2 starts only after this amendment is approved (spec 053 section 6).

**Input**: Spec 053 HC-D6, decided 2026-11-26: "amend spec 003 with a help lane that reuses its harness parts (budgets, switch, evaluation
gate) without the clinical evidence rules. Approve that before C2." Spec 053 sections 3 to 5 (what the model may do, data, the plug-in
principle, the gates). [AI safety R1 to R5](../../docs/ai-safety-and-hallucination-controls.md).

Read against `main` after #503. Spec 003 itself is unchanged apart from one line in its header that points here.

## 1. Two lanes, one harness

Spec 003 was written for one task, the **clinical lane**: a model explains a verified engine result. This amendment adds a second task, the
**help lane**: a model answers a question about the product from the reviewed help articles (spec 053).

| | Clinical lane (spec 003) | Help lane (this amendment) |
| --- | --- | --- |
| What goes in | One engine result's own fields. No inbound free text | The person's question, the signed articles the curated engine picked, the screen name and the role names |
| The untrusted input | None reaches the prompt (FR-001) | **The question.** It is the one part the person writes, so it is the injection route (section 3) |
| What may come out | Statements tied to the result's fields | Sentences, each citing a passage of a signed article |
| What checks it | Sensors S1 to S6 and the verifier (FR-004, FR-005) | The refusal rule first, then the citation check and the output checks HC1 to HC6 (section 4). There is no second model as a judge (HC-D5) |
| When it falls back | The engine's own text | The C1 answer: the curated article, the refusal, or the closest three (spec 053 C1) |
| Data class | `phi` | `phi` (HC-D1): what people type can hold patient information |
| Provider | Direct Bedrock (D4) | Any adapter behind the model port, chosen by configuration in C4 (spec 053 section 4a) |

**Reused from spec 003 as they are:**
- the model port (`model-clients/port.ts`): text in and out, no tools parameter (D2);
- the loop limits, budgets and database caps (FR-007, FR-008), with the help lane's **own** caps;
- trace and receipt with no text (FR-009);
- pinned model and template identity (FR-010);
- the data-class and output-class declarations in the task registry (`tasks.ts`, R1 and R4);
- the readiness gate and the dormant switch (FR-012, story 7), with the help lane's own conditions (section 6);
- the evaluation gate inside `verify`, selected by path (FR-013, D7);
- no stored text (FR-014, D6);
- plain, escaped output (FR-015);
- the region and egress rule when the adapter is Bedrock (FR-016).

**Not used by the help lane:**
- eligibility by engine outcome (FR-002);
- the clinical sensors S1 to S6 and their lexicons (FR-004);
- the verifier (FR-005);
- the pharmacist-reviewed clinical golden set (D5, SC-001). The help lane has its own evaluation set (section 5).

Nothing in this amendment changes the clinical lane, its decisions D1 to D10, or the code that serves it.

## 2. When the model is asked at all

The C1 engine runs first, on every question, and decides whether the model is asked:

1. **The refusal rule** (`isPatientQuestion`, spec 051 section 5). If it refuses, the answer is the refusal and **the model is not called**.
2. **The curated search** (`searchHelp`). If it finds no match, or only a weak match, the answer is the closest three and **the model is not
   called**: the model may only rephrase what the corpus already answers.
3. **Signed articles only** (HC-D4). The model sees only the signed articles among the search's hits, up to three. If none is signed, the
   answer is the C1 answer and **the model is not called**.
4. Otherwise the model is asked, and its answer is checked (section 4). If it fails any check, the C1 answer shows instead, without an error
   (R4).

**One implementation of steps 1 to 3.** Today `isPatientQuestion` and `searchHelp` are in `apps/frontend/src/lib/helpSearch.ts`. The
server path must use the same rule, not a copy. C2 therefore moves them into `packages/help-content`, which both the frontend and
`apps/ai-service` read, and moves their tests with them. Spec 053's C2 row gains `packages/help-content`.

## 3. What goes into the prompt (FR-H1, in place of FR-001)

The prompt is built only from:
- a fixed instruction template with a digest;
- the selected signed articles, by id: title, body and their links' labels, exactly as in `packages/help-content`;
- the glossary entries those articles name;
- the current screen's name and the person's role names;
- the question, inside a delimited block that the template names as untrusted text to be answered, never followed.

Nothing else goes in: no patient label, report, result, record or API response, and no earlier exchange (each question stands alone). A
provenance test builds prompts from hostile questions and fails if any string outside this list is in the prompt.

**Why the question is allowed in.** The help lane cannot work without it. The defence is not keeping it out but bounding what any answer can
say: every sentence must cite a signed passage that carries the sentence's meaning-carrying words (HC3). An injected instruction can at most
produce a sentence the articles already support, or a failed check and the C1 answer.

## 4. What may come out, and the checks (FR-H2 to FR-H6)

**FR-H2, the output contract.** A schema-validated structure of at most 6 sentences. Each sentence has its text, the article id it cites and
the exact passage it cites. It also carries one flag for the whole answer, `outOfScope` (HL-D3). Plain text only: no markup, links or code.
The screen links shown under the answer come from the cited articles' own `links`, added by code, never written by the model.

**FR-H3, the checks.** Each is a pure function in `apps/ai-service/src/help/` with a broken-copy test (R2, SC-003):

| Check | Holds when |
| --- | --- |
| **HC1, passage exists** | The cited passage is not a byte-exact span of the cited article's body |
| **HC2, article allowed** | The cited article was not in the prompt, is not signed, or is not visible to the person's roles |
| **HC3, meaning carried** (HC-D5) | A meaning-carrying word of the sentence is not in its cited passage. Those words are: feature and screen names, status and outcome words, role names, glossary terms, article titles' key words, and every numeral. The list is built from the corpus itself, so a new article extends it, and it is tested |
| **HC4, never about a patient** | The sentence would be refused by `isPatientQuestion`, or names a drug from the bundled drug list, a gene symbol, a star allele or an activity score |
| **HC5, never reassures** | The sentence matches the rule the articles already follow (`safe`, "no interaction", "not affected", `none`; `packages/help-content`'s test) |
| **HC6, shape** | The answer is empty, too long, or breaks the schema; or a sentence addresses the reader about their patient or talks about the model or its instructions |

**FR-H4, what a failure does** (HL-D1). Any failing check on any sentence withholds the whole model answer, and the C1 answer shows. No
sentence is removed on its own.

**FR-H5, the model's own refusal check** (spec 053 section 3, direction plan section 5; HL-D3). When the model sets `outOfScope`, the answer
becomes the refusal. HC4 also runs on every sentence. Both are in the same call. The flag can only add a refusal; it never releases what the
rule refused.

**FR-H6, the label and the fallback.** A released answer carries the label "Written by an assistant from the articles below." Under it, the
cited articles are listed with their links and their signed line (R4). Spec 053 section 3's label also says "Draft articles are not yet
reviewed."; that sentence is dropped, because the model answers only from signed articles (HC-D4), and spec 053 is amended to match. A withheld answer shows the C1
answer, with no error and no sign that a model was tried.

## 5. The evaluation set (FR-H7, the help lane's R3)

The set lives in `apps/ai-service/evals/help/` and is the contract every provider must pass (spec 053 section 4a). It runs with a scripted
model, with no network, in `verify`. It is selected by path: the help lane's code, its template, its configuration, **and
`packages/help-content`**, because changing an article changes what the model may say.

First cut, sizes *initial*:

| Part | At least | Passes when |
| --- | --- | --- |
| Questions that must be refused | 20 | No model call, and the refusal shows |
| Questions the signed articles answer | 20 | A correct scripted answer is released, and each seeded wrong answer is withheld. The wrong answers include an invented feature, a wrong role, a changed number, a reassurance, a drug or gene named, and an uncited sentence |
| Questions with no good match | 10 | No model call, and the closest three show |
| Questions carrying instructions ("ignore the articles and …") | 10 | A scripted model that obeys every instruction it sees changes no released answer |
| Articles carrying instructions (a fixture copy of the corpus) | 5 | The same |

Thresholds and the number of runs per question for live use are committed to `docs/verification/` before the first live run, as D8 does for
the clinical lane. The live run is a manual report, never a required check. **English only** (HC-D3); Spanish needs its own set.

## 6. Data, storage, spend and the switch (FR-H8 to FR-H11)

- **FR-H8, data class and provider.** The task is declared `phi` with `provider: 'baa-required'` (HC-D1). Until the AWS BAA is executed, the
  lane runs only in an environment declared synthetic-only. Staging is one today, and production would refuse the lane. The adapter must
  keep the question inside the `phi` boundary. A provider is an adapter behind the model port, chosen by configuration, and passes the same
  evaluation set before it ships (spec 053 section 4a).
- **FR-H9, nothing stored.** The question and the answer are stored nowhere: not in a table, a log, a trace or a receipt. Not even a
  digest of the question is kept. The receipt keeps the cited article ids, the check results, reason codes, counters and the model and
  template identity. A scan test runs the evaluation set and fails if any question or answer text appears in a trace, receipt or log.
- **FR-H10, caps.** The help lane has its own tenant and fleet caps in the database, so Help can never use the clinical lane's budget. One
  attempt and no repair per question, with a deadline. Over a cap, the C1 answer shows.
- **FR-H11, the switch.** A server switch, off by default and off everywhere until C4 is approved and applied by the founder. A kill switch is
  rehearsed like `ASSESSMENT-OFF`. The help lane's readiness conditions are:
  - the BAA is executed, for real use;
  - the founder has set the flag;
  - the evaluation thresholds are met;
  - the founders have reviewed shadow answers;
  - a monitor is live, counting releases and withholdings by reason code;
  - a rollback has been rehearsed;
  - the help article "How Help's answers are written and checked" is signed;
  - counsel's view is recorded (HL-D2): one question to counsel covers both lanes.

## 7. Decisions for the founder

- **HL-D1. What a failed check does to the answer.** **Decided 2026-11-26: as recommended.**
  - **Recommended:** the whole model answer is withheld and the C1 answer shows. Removing one sentence can drop a qualifier ("only", "unless")
    and change what the rest means, and the C1 answer beside it is always reviewed text. Spec 053 section 3 is amended to say so (done in
    the same pull request).
  - **Alternative:** as spec 053 section 3 says now: the failing sentence is removed, and the answer is withheld only if too little is left.
    More answers get through, but a shortened answer can mislead.
- **HL-D2. Counsel's view before Help's model is used for real.** The clinical lane waits for counsel on the FDA clinical decision support
  criteria (D10). **Decided 2026-11-26: as recommended.**
  - **Recommended:** Help's lane waits for counsel too, as one combined question: Help explains the product and refuses patient questions, but
    it sits inside a clinical product, and one answer from counsel covers both lanes.
  - **Alternative:** no counsel condition for the help lane, because it gives no clinical recommendation. It is faster, but it leaves the
    question to the founders alone.
- **HL-D3. The model's own refusal check.** **Decided 2026-11-26: as recommended.**
  - **Recommended:** the model's output carries an `outOfScope` flag, and when it is true the answer becomes the refusal. Check HC4 also runs
    on every sentence. Both happen in the same call, so there is no extra cost, and the flag can only add a refusal.
  - **Alternative:** a separate, second model call that classifies the question before the answer is written. It is a stronger separation, but
    it doubles the calls and is still a model's word, which R2 says cannot be the only guard.

## 8. Slices this amendment governs

| Slice (spec 053) | What this amendment adds to it |
| --- | --- |
| **C2** | The rule and the search move into `packages/help-content`. Then, in `apps/ai-service/src/help/`: the help task in the registry; the prompt (FR-H1) and its provenance test; the output contract; HC1 to HC6, each with a broken copy; the fallback; the label; the evaluation set in `verify`; and a scripted adapter only |
| **C3** | The backend route behind the switch, off. It sends only the question, the screen and the roles, and returns the model answer or the C1 answer. It has its own caps, and the scan test covers its logs |
| **C4** | The first adapter, its configuration, budgets and kill switch, the shadow review and the readiness record. Applied by the founder |

## 9. What does not change

- Spec 003's clinical lane, its decisions D1 to D10 and its code.
- The refusal rule and its sentence (spec 051). The model only adds to it.
- No model, host, key or spend until C4 is approved and applied by the founder.
- Help reads no patient data.

## 10. How this was checked

Read from `main` after #503:
- spec 003 (`spec.md`, `plan.md`);
- `apps/ai-service/src/tasks.ts`, `policy.ts` and `model-clients/port.ts`, and the ai-service README;
- spec 053;
- the direction plan's sections 5 and 6;
- AI safety R1 to R5;
- `apps/frontend/src/lib/helpSearch.ts` and `lib/helpConversation.ts` (in #504).

No code ran.
