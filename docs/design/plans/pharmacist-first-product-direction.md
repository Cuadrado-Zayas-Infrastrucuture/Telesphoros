# Plan: a pharmacist-first product, with chat as the help assistant

Status: **draft, awaiting founder review. Plan only: no code, migration, dependency, infrastructure or clinical content changes, and nothing
here is approved beyond the four decisions in section 2.** Snapshot 2026-11-21 against the session branch `claude/gracious-wright-1u4guu`.
It does not replace the [repository audit and build plan](repo-audit-and-build-plan.md), the
[intended-use assessment](m0-1-intended-use-and-regulatory.md) or the [gap analysis](pgx-build-prompt-gap-analysis.md); it sets the
product direction those plans' slices serve, and each slice below gets its own spec, plan and draft pull request.

## 1. Why this exists

The founder asked whether Telesphoros can be a stronger product than "another chat", and asked for research on the competition first. The
current home is a chat (specs 024, 038, 041), but on staging it is an upload form in a chat frame: a typed question gets "Questions cannot
be answered here." (`apps/frontend/src/components/workspace/WorkspaceConversation.tsx`), and no model is behind it. The audits keep finding
defects that come from that shape: a report attached to the first loaded patient (038 F01), a box that invites a question it cannot answer
(038 F02), and three ways to move around with "Back to chat" the only way back (041 items 4 and 5; slice C waits on a navigation decision).

## 2. Decisions recorded (founder, 2026-11-21)

| # | Decision | Replaces or amends |
| --- | --- | --- |
| **N1** | **The first user is a pharmacist-led PGx service.** Prescribers are the people the service writes to, and come second as direct users. | Consistent with M0.1 I1 a ("pharmacists and clinicians"); no conflict |
| **N2** | **The clinical home is a worklist by role**: reports to review, held results, follow-ups due, recent assessments. | Answers the navigation decision spec 041 slice C waits for |
| **N3** | **Chat is the product's help assistant**: it explains every feature, how things work in the product, FAQs and policies. It is not the clinical interface and never answers a clinical question about a patient. | **Replaces** the 2026-11-02 direction "the primary clinical interface is chat" ([physician-chat-and-patient-record.md](physician-chat-and-patient-record.md)). Spec 024 D3 and spec 038 D3 are amended by the assistant slice (A3), not by this document |
| **N4** | **The help assistant starts with curated answers, to ship faster and prove the concept**: reviewed articles matched to the question, the screen and the role, with no model. A model is added later as the business lane of the existing agentic design (M0.1 I4: staff SOP and FAQ help, English and Spanish, read and draft only), answering from the same articles. | Revised the same day: the founder first chose a model from the start, then chose curated first. The model's gates (section 6) apply to slice A4 only |

## 3. What the research found

Web research on 2026-11-21. **V** = read in the source; **S** = from a search summary or vendor marketing, check before relying.

| Group | Examples | What the clinician sees | Limit | Conf. |
| --- | --- | --- | --- | --- |
| Lab-bundled reports | GeneSight, Genomind, OneOme RightMed (assets bought by Tempus November 2025, national launch 2026-07-22), Quest with Coriell's GeneDose LIVE | A portal and a PDF with traffic-light categories | One lab's tests only; GeneSight requires the clinician to enrol to order; the software exists to sell the test | S |
| EHR-native genomics | Epic Genomic Module ("genomic indicators"), Oracle Health | Passive flags and order-time alerts in the chart | Each lab needs an HL7 interface and custom middleware; the published accounts are large academic centres (UF, Penn, UCSF) | S |
| CDS engines sold to labs and systems | Translational Software, GenXys TreatGx, ActX, FDB, Coriell (bought by InformedDNA, 2025) | Mostly invisible: content and APIs under someone else's brand | Little independent evidence (TreatGx's main study is a 2016 pilot, 236 uses) | S |
| AI chat for clinicians | OpenEvidence (about 1.1 million verified US clinicians), ChatGPT for Clinicians (free since 2026-04-22), PGxAI | Chat | Does not know the patient's genotype; LLMs answering CPIC questions scored 85 to 93% accuracy even when retrieval-grounded | S |

Gaps the literature names:

1. **Results are lost in PDFs.** PGx results arrive as PDFs, are scanned into the chart and are rarely used again, although they matter at
   every later prescription; discrete, computable results are called the gold standard. (S)
2. **Well-designed PGx alerts are followed** (one study: about 92% adherence), while general medication alerts are overridden 46 to 96% of the
   time. Penn keeps PGx alerts passive and interrupts only where CPIC recommends an alternative. (S)
3. **Pharmacists already run PGx services**: one health system's pharmacist-led service held 1,939 PGx visits under a standard workflow; in
   another study pharmacist review found 24% of a lab's automatic flags had immediate clinical value. (S)
4. **FDA's January 2026 CDS guidance keeps criterion 4**: the clinician must be able to review the basis independently, and a black box is
   more likely to be treated as a device. M0.1 section 2 already reads the guidance itself. (V there)

**Where Telesphoros differs.** The gap analysis already names the signed, verbatim, five-outcome model as "this product's differentiator".
Against the market that is three things no competitor above combines: a record that does not belong to one lab, a basis shown for every
result (and a reason for every hold), and a team workflow with independent review and a hash-chained ledger. A fourth is unique in what was
found: **follow-up outcomes**, recorded in ordinary care and feeding Data Insights and a payer-sponsored program's evidence of "less trial and
error" ([pgx-data-model-and-data-products.md](pgx-data-model-and-data-products.md), zone S). No competitor found records what happened after
a PGx-guided change.

**What to avoid:** competing on chat. A free, well-funded clinical chat already exists. N3 and N4 keep the chat where it cannot compete with
it and where it cannot be mistaken for clinical advice.

## 4. Where the repository stands against that edge

Read from source on 2026-11-21. None of this is clinical approval.

| Edge | Today | Missing |
| --- | --- | --- |
| A record that does not belong to one lab | Structured reports carry `laboratoryId`, `seriesId` and revisions; `apps/backend/src/patient-identity/structured-reconciliation.ts` reconciles one patient's revisions with conflicts and reviewer resolutions (synthetic only) | The PDF reader (a recorded-text stand-in replays twelve development PDFs; the engine is not in the repository); any real lab layout (M0.1 I2: not yet named) |
| A basis for every result, a reason for every hold | The engine copies wording, strength and citation; five outcomes and 15 reason codes (`packages/cpic-schema/src/vocabulary.ts`) | Real signed content: `knowledge/cpic` is empty until clinical sign-off (M2.4) |
| Results kept current when guidelines change | Each evaluation stores its `knowledgeSetId`; corrections supersede; `coverage-diff` is an operator CLI | No re-evaluation when a knowledge set changes |
| Team workflow and audit | Independent review, corrections, disputes, clinician decisions and acknowledgements exist, behind `LAB_REPORT_PIPELINE`, which production refuses | On staging nobody can record a decision on a result |
| Medication review | Medications are recorded from a bundled RxCUI list; writes are fenced (`MEDICATION_WRITES`) | Medication–gene flags: spec 031 is a draft, no code |
| A worklist | `GET /followups`, `/cell-disputes`, `/patient-link/quarantine`, `/patient-duplicates`, the structured preview reviews | One read that brings them together; a result worklist |
| Follow-up outcomes | Follow-up inbox, summary and response chart; writes fenced (`FOLLOWUP_WRITES`, refused in production) | Treatment-linked observations, Data Insights release |
| EHR | `packages/smart-pilot`: a loopback-only OpenEMR SMART launch and FHIR preview | CDS Hooks (none); `packages/fhir-utils` is empty |

## 5. The product shape

### The pharmacist's day (N1, N2)

1. **Home: the worklist.** One list, by role, of what needs a person: reports whose patient link or findings wait for review, held results
   with their reason, follow-ups due or overdue, disputes, possible duplicates. Each row opens the place where the work is done. Nothing is
   inferred: an empty section says it is empty, and a section the server cannot read says so.
2. **Patient: the PGx profile.** The main clinical screen. Genes and phenotypes from every accepted report, with the source report, lab and
   revision beside each; conflicts shown, never silently resolved; current medications; every result with its outcome, reason code, guideline
   wording and citation; decisions and follow-ups one step away (spec 038 F03).
3. **Medication review** (after spec 031): each current medication marked "Review" or "Held" with its evidence on demand; never "safe".
4. **A note for the prescriber**: what the pharmacist recommends, in their own words, beside the guideline's verbatim wording and citation.
   The pharmacist writes it; the product never drafts a clinical recommendation (gap analysis D2 = A).
5. **Follow-up**: the existing treatment-linked documentation and reminders, which become Data Insights' source.

A command bar ("Open patient…", "Attach report…") keeps the speed of typing without a conversation. It runs product actions only.

### The help assistant (N3, N4)

- **Where:** a side panel that opens from any screen, beside the work. It is not the home.
- **What it answers:** what a feature does and how to use it; what a status, outcome or reason code means in general; why a control is
  unavailable to this role or in this build; FAQs; the product's published policies. Answers link to the screen that does the job; the
  assistant itself performs no action (tier T0 in [agent-approval-tiers.md](agent-approval-tiers.md)).
- **What it refuses:** any question about a specific patient's genes, results, medications or care. It answers with a fixed sentence and a
  link to that patient's profile, where the engine's result and its basis are. The refusal is a deterministic, tested rule (A3); when a model is added (A4) it adds its own check and never replaces the rule.
- **What it reads:** a reviewed help corpus in the repository (feature articles, FAQs, glossary, approved policy text), the name of the
  current screen and the user's roles. **Never** patient records, report content or anything read from the clinical API.
- **Languages:** English and Spanish, evaluated separately (AG-D1).
- **How it answers, first (N4):** without a model. The panel opens on the articles for the current screen and role, searches every article as
  the user types, in both languages, and shows the matching article with its links. A question with no good match says so and offers the
  closest articles; it never guesses. Questions people type are counted by topic only, never stored as text, so the record cannot hold
  patient information; that count is the evidence for the proof of concept and the starting question set for the model's evaluation.
- **How it answers, later (A4):** a model answers from the same articles and cites them. The articles stay the source of truth, so the
  curated assistant is the fallback whenever the model is off, failing or over budget.

## 6. Gates the model must pass before A4 (from documents already on record)

None of these gates applies to the curated assistant in A3, which calls no model. A3 has its own, lighter checks: every article is reviewed
before it is published (F2), the refusal rule for clinical questions is deterministic and tested with questions that must be refused, and the
panel reads no clinical API (a test asserts it).

| Gate | Source | What it means here |
| --- | --- | --- |
| A data class for the task, held by a test | AI safety R1 | The user's typed text can carry patient information even though the corpus does not. R1 says "when unsure, the class is `phi`". **Decision F1** |
| Every output guard has a production caller | R2 | The grounding check (answer cites corpus passages that exist) and the clinical-question refusal are both on the serving path, each proved by a deliberately broken test |
| Evaluation before any prompt, model or decoding change merges | R3 | A required check on the pull request, over a fixed question set in both languages, including clinical questions that must be refused and injected text in the corpus |
| Free text shown to a person is checked, withheld or labelled | R4 | Answers are labelled as assistant output, carry citations to help articles, and are withheld when the citation check fails |
| Retention, purge and erasure of stored model text | R5 | Decide whether conversations are stored at all; the default in this plan is **not stored** beyond the session |
| Hosting and spend | M0.1 I4, AG-D7 (open) | Self-hosted open-weight models or Bedrock ([engine-durable-admission.md](engine-durable-admission.md)); no model, host or spend is approved |
| Model path dormant until switched on | Spec 003 story 7 | A server switch, off by default, with a kill switch rehearsed like `ASSESSMENT-OFF` |

## 7. Slices (each its own spec, plan and draft PR off `main`; none started)

| Order | Slice | Touches | Depends on |
| --- | --- | --- | --- |
| 0 | **This plan** | `docs/` only | none |
| A1 | **Navigation and the worklist home.** Folds in spec 041 slice C and spec 040 slices B and C. The chat leaves the centre; the home becomes the worklist; one read endpoint gathers the existing queues without new clinical logic | Frontend; one read-only API route | N2 |
| A2 | **The patient PGx profile.** Reads existing evaluations and the structured reconciliation; shows sources, conflicts and holds | Frontend; possibly one read-only route | A1 |
| A3 | **Help assistant, curated (the proof of concept).** Released to users. The panel; the article format and the first reviewed articles in English and Spanish; help for the current screen and role; search as you type; the deterministic refusal rule for clinical questions; topic counts of what people ask. No model and no new clinical read. Amends spec 024 D3 and spec 038 D3 | Frontend; docs; possibly one route for topic counts | N3, N4, F2, F3 |
| A4 | **Help assistant, model added.** Answers from the A3 articles with citations; the citation check and refusal on the serving path; the evaluation set built from A3's topics, as a required check; the chosen host, budgets, the dormant switch and kill switch; the curated answers as fallback | `apps/ai-service`, backend, Terraform | A3 in use, AG-D7, F1, R1 to R5 tests |
| B1 | **Decisions and the prescriber note on synthetic staging.** Today decisions sit behind the pipeline, which production refuses | Backend gates; frontend | F4 |
| B2 | **Medication review.** Spec 031 approved, MD-6 superseded by that approval | Backend, frontend, knowledge | Spec 031, M2.4 signed content |
| later | Real signed knowledge (M2.4), the real reader and named lab layouts (M3.1), re-evaluation on a new knowledge set, SMART launch and CDS Hooks (G5.2, G5.3), Data Insights release | as their plans say | M0.1 counsel answers |

A1, A2 and A3 need no clinical gate and no model, so they can start first and run side by side.

## 8. Decisions only the founder can make (open)

- **F1. The assistant's data class.** (a) `phi`: the typed text is treated as possibly carrying patient information, so the model runs only
  on a host inside the platform's boundary, and real use waits for the AWS BAA. (b) `no-phi`, with a pre-check that refuses text that looks
  like patient information. The pre-check cannot be complete, so R1's "when unsure, `phi`" points to (a). **Recommendation: a.** Needed
  before A4 only; A3 sends typed text to no model and stores none.
- **F2. Who writes and reviews the help corpus**, in English and Spanish. Until named, the founder owns it (M0.1 I5 d).
- **F3. Which policies the assistant may quote.** `docs/legal/privacy-policy-draft.md` is a draft; the assistant should quote only text the
  founder and counsel have published.
- **F4. Clinician decisions on synthetic staging.** Whether decisions, acknowledgements and the prescriber note may run in the synthetic
  assessment mode, outside the pipeline, which production refuses. This is a gate change and needs its own plan.
- **F5. The first usability sessions.** [The usability protocol](../clinical-workspace-usability-protocol.md) has never been run. Running it
  with pharmacists before A1 is fixed would test the direction cheaply.

## 9. What this does NOT touch

Code, migrations, dependencies, CI, Terraform, knowledge files, the clinical hold, the approval tiers, the regulatory decisions I1 to I5,
the gap analysis decisions D1 to D3, specs 024, 038 and 041 (their amendments belong to slices A1 and A3), and the vault. It approves no
model, host or spend.

## 10. How this was verified

- **Read in this repository:** `CLAUDE.md`, `docs/ops/environments.md`, `docs/STATUS.md` (what exists, next, waiting, decisions, working
  agreements), `docs/architecture.md`, `docs/product-capabilities.md`, `docs/investor-demo.md`, `docs/fhir-cds-hooks.md`,
  `docs/ai-safety-and-hallucination-controls.md`, `docs/design/branding.md`, `docs/design/clinical-workspace-usability-protocol.md`, the plans
  `m0-1-intended-use-and-regulatory.md`, `physician-chat-and-patient-record.md`, `pgx-build-prompt-gap-analysis.md`,
  `pgx-data-model-and-data-products.md`, `agent-approval-tiers.md` and `business-synthetic-kernel.md`, specs 024, 031, 038 and 041, and
  `apps/ai-service/README.md`. Source: `WorkspaceConversation.tsx`, the frontend routes and component list, and an inventory of
  `apps/backend/src`, `packages/`, `apps/worker`, `sidecars/`, `ml/` and `knowledge/` (routes, flags, engines, vocabulary, stand-ins).
- **Not read:** the vault (local to the founder's machine); in particular the agentic design packet's `design.md`, contracts and budgets,
  which M0.1 section 7 also lists as unread. Section 6 relies on the repository's summary of that design.
- **Not verified:** every row in section 3 except item 4 comes from search summaries and vendor material, not the full sources; no vendor
  product was used. Nothing was run, built or deployed, and no model was called.

Sources for section 3:
[GlobeNewswire market report](https://www.globenewswire.com/news-release/2026/11/16/3403801/28124/en/genomic-clinical-decision-support-market-size-share-trends-and-forecast-2026-2036-ai-ehr-integration-and-pharmacogenomics-drive-13-8-cagr-to-usd-5-18-billion-by-2036.html),
[Quest and GeneDose LIVE](https://clpmag.com/diagnostic-technologies/molecular-diagnostics/molecular-diagnostic-analyzers/quest-diagnostics-launches-pharmacogenomics-testing-service/),
[InformedDNA acquires Coriell](https://www.healthcaredive.com/press-release/20250319-informeddna-acquires-coriell-life-sciences-expanding-precision-health-capa/),
[Tempus OneOme launch](https://www.tempus.com/news/pr/oneome-pharmacogenomics-national-launch-2026/),
[Tempus acquires OneOme assets](https://genomeweb.com/cancer/tempus-acquiring-pharmacogenetics-assets-recently-defunct-oneome),
[UF Health and Epic's Genomic Module](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC11695119/),
[Epic Genomic-Indicators usability study](https://pubmed.ncbi.nlm.nih.gov/41723510/),
[Penn Medicine PGx program](https://www.med.upenn.edu/pgi/assets/user-content/documents/publications/piis2949774423007884.pdf),
[GeneSight review, AAFP](https://www.aafp.org/pubs/afp/issues/2021/0700/p89.html),
[TreatGx pilot](https://www.genomebc.ca/precision-medicine-support-tool-primary-care-physicians-proves-feasible),
[Translational Software API](https://www.healthcareitnews.com/news/new-fhir-based-genomics-api-promises-accelerate-precision-medicine),
[PGxAI listing](https://partner.intersystems.com/package/PGxAI),
[OpenEvidence and MSK](https://www.fiercehealthcare.com/health-tech/openevidence-deepens-oncology-push-expands-ai-decision-support-cancer-care),
[OpenEvidence usage, JAMA](https://jamanetwork.com/journals/jama/fullarticle/2855492),
[LLM guideline extraction, JMIR 2025](https://www.jmir.org/2025/1/e73486/PDF),
[Sherpa Rx](https://arxiv.org/pdf/2507.21453),
[Baylor PGx assistant](https://hgsc.bcm.edu/rotor/using-generative-ai-assistant-interpret-pharmacogenetic-test-results),
[PGx alert adherence](https://ouci.dntb.gov.ua/works/4NQxmk87),
[Overridden CPOE alerts review](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC7400042/),
[PGx results in PDFs](https://pmc.ncbi.nlm.nih.gov/articles/PMC7233102),
[Structured genomic results](https://www.hcinnovationgroup.com/clinical-it/genomics-precision-medicine/article/21077005/progress-toward-return-of-structured-genomic-results-for-clinical-decision-support),
[Pharmacist-led PGx service](https://pmc.ncbi.nlm.nih.gov/articles/pmid/39166145),
[Pharmacist consult reports](https://www.dovepress.com/pharmacist-consult-reports-to-support-pharmacogenomics-report-interpre-peer-reviewed-fulltext-article-PGPM),
[FDA CDS guidance takeaways, Covington](https://www.cov.com/news-and-insights/insights/2026/01/5-key-takeaways-from-fdas-revised-clinical-decision-support-cds-software-guidance).
