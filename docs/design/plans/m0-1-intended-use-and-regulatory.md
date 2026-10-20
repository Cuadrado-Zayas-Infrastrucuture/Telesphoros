# Plan: M0.1, intended use and regulatory assessment (draft for the founder and counsel)

Status: **draft, awaiting founder decisions I1 to I5.** Snapshot 2026-10-19 against main `ac7bc72`. **This is a plan only: no code, migration, infrastructure or clinical content changes, and nothing here is approved.** It is a working document for the founder and counsel, **not legal advice and not a regulatory determination.** Every FDA statement below was read in the guidance itself; what was not read is listed in section 7.

## 1. Why this exists

No clinical slice starts before M0.1 ([pgx-build-prompt-gap-analysis.md](pgx-build-prompt-gap-analysis.md), section 5). Its outcome decides what the knowledge pipeline (M2.4), the review journey (M3), the PharmCAT slices (G3), the narrative interpreter and verifier (G4) and any data product may do. The roadmap row is "intended use, supported reports, regulatory assessment, retention classes, roles, owners" ([repo-audit-and-build-plan.md](repo-audit-and-build-plan.md), M0.1, task T01).

## 2. What the FDA guidance says (read in full for sections IV and V)

Source: FDA, *Clinical Decision Support Software*, guidance for industry and FDA staff, **issued 2026-01-29, superseding the version issued 2026-01-06** (title page; page numbers below are the PDF's). It is nonbinding. The statute is section 520(o)(1)(E) of the FD&C Act (21 U.S.C. 360j(o)(1)(E)): a software function is **excluded from the device definition only if it meets all four criteria**.

| Criterion | What the guidance says (paraphrased) | Page |
| --- | --- | --- |
| 1. Not intended to acquire, process or analyze a medical image, a signal from an in vitro diagnostic (IVD), or a pattern or signal from a signal acquisition system | If that kind of data is an input, the function **remains a device**. For next-generation sequencing, genetic sequences, **including datasets of variants and variant call format (VCF) files, are examples of "patterns"**. Software that processes or analyzes genetic sequence or patterns from an NGS analyzer to identify variants, or their clinical implications, **does not meet Criterion 1** | 7 to 8 |
| 2. Displays, analyzes or prints medical information about a patient or other medical information | A single discrete test result is "medical information" (a lab value in a record is the example). If Criterion 1 is met, results from IVD tests **used consistently with FDA-required labeling** are generally medical information. Clinical practice guidelines and peer-reviewed studies are "other medical information" | 9 to 10 |
| 3. Supports or provides recommendations to a health care professional (HCP) about prevention, diagnosis or treatment | Software that gives **options** or a prioritized list meets it. Software that gives **a specific preventive, diagnostic or treatment output or directive fails it**. Matching patient-specific information to guidelines is listed as meeting it. If only one option is clinically appropriate and the other criteria are met, FDA says it **does not intend to enforce** (enforcement discretion), but not for time-critical uses, and not where the function also uses genomic or other data without established relevance, or data that is not well understood and accepted for the stated use | 10 to 13 |
| 4. Lets the HCP independently review the basis, so the HCP does not rely primarily on the recommendation | FDA recommends: the intended use, HCP user and patient population stated; the required inputs described; a **plain-language description of the algorithm, the data relied on and the validation**; and output that shows the patient-specific information and what is missing or unexpected. **A critical, time-sensitive task is not considered to meet Criterion 4.** FDA also weighs the level of automation and automation bias | 14 to 15 |

Two consequences stand out:

- **The VCF question is answered by the guidance, not left open.** Software that processes a VCF to call variants and their implications fails Criterion 1 and remains a device. This **corrects** the earlier research table: [pgx-data-model-and-data-products.md](pgx-data-model-and-data-products.md), row R16, said "Genomic data is not discussed", and its section 7 treated the VCF question as open. It was read through a summary then; the guidance itself says otherwise.
- **Recipients matter.** The exclusion covers software for HCPs. Software that gives recommendations to patients or caregivers meets the device definition (p. 13).

## 3. How the current design maps (from the repository)

| Fact | Where | Against the criteria |
| --- | --- | --- |
| Input today is the diplotype or phenotype a **lab printed on a report**, read from the report text; nothing processes variants | [lab-report-reader.md](../../lab-report-reader.md), [cpic-integration.md](../../cpic-integration.md) | Fits Criterion 2 if the lab's test result counts as medical information. **Open:** whether a result from a lab-developed test counts as "consistent with FDA-required labeling" |
| The engine returns the guideline's wording **verbatim**, with its citation and verification state; a cell that is unverified or disputed shows no wording | `packages/cpic-schema/src/evaluation.ts`; the gap analysis | Matching patient information to a published guideline fits Criterion 3. **Open:** whether verbatim CPIC wording such as "avoid" is "a specific treatment directive" |
| Every stored evaluation says `clinicalUse: "not-approved"` and `actionable: false` | `packages/shared-types/src/lab-report.ts` | Today's state is research and demonstration only |
| Every gene input says where it came from (`callSource: 'lab-report'`) | PR #188 | Supports Criterion 4: the HCP can see the source of each value |
| A VCF can be uploaded and gets a header-only structural check in intake; it is **accepted, not interpreted**, and no variant is called from it | [pgx-build-prompt-gap-analysis.md](pgx-build-prompt-gap-analysis.md) (rows on `vcf-validate` and the options table); `apps/backend/src/reports/intake/structural-validator.ts` | Interpreting it would fail Criterion 1 (section 2). **Open for counsel (question 4):** whether accepting and storing a VCF, with no interpretation, is itself acceptable |
| The planned interpreter writes narrative text with an LLM; the verifier is rule-based; clinicians are in the loop | [pgx-data-model-and-data-products.md](pgx-data-model-and-data-products.md) | Raises the automation and "intended to replace or direct judgment" questions under Criteria 3 and 4 |

## 4. The decisions

### I1. Intended use and who the user is

| Option | What it is | For | Against |
| --- | --- | --- | --- |
| **a. Non-device CDS for HCPs, lab-reported results only** | Pharmacists and clinicians review guideline-sourced information about a patient's reported result, with the basis shown | Fits the four criteria as read, if I3 and the open questions come out right; no premarket submission | Depends on counsel's answers; narrow |
| b. A device (a premarket pathway) | Accept the device definition and pursue FDA review | Needed if the product processes VCFs or gives a directive | Heavy cost and time; a different product and quality system |
| c. Research and demonstration only (today) | `clinicalUse: "not-approved"` stays | No regulatory exposure now | No clinical use, no revenue from clinical users |

**Recommendation: a**, stated in writing as the intended use, with c as the status until counsel confirms.

### I2. Supported inputs and reports

| Option | What it is | For | Against |
| --- | --- | --- | --- |
| **a. Lab-reported results only (PDF reports), a named list of supported lab report layouts** | The current design; a VCF stays "accepted, not interpreted" | Stays on the Criterion 2 side | Depends on labs reporting diplotypes |
| b. Also VCF files | Variant files processed by the product, with or without PharmCAT | More input coverage | **Fails Criterion 1 per the guidance, so it needs option I1 b** |

**Recommendation: a.** Treat VCF and PharmCAT (G3.1, G3.2) as device-path work and keep them out of the non-device scope. The list of supported lab layouts is yours to name.

### I3. How a recommendation is shown

| Option | What it is | For | Against |
| --- | --- | --- | --- |
| **a. Guideline-sourced information with the citation and options, never a standalone directive** | The engine's verified wording shown as what the named guideline says for this result, with the basis and what is missing | Aims at Criteria 3 and 4 | Counsel must confirm the verbatim wording is not a directive |
| b. A single directive ("do X") | | Simplest to read | Fails Criterion 3 as read; falls to the device path unless enforcement discretion applies |

**Recommendation: a.** The enforcement-discretion route (one clinically appropriate option) is narrower than it looks: it excludes time-critical uses and genomic inputs without established relevance, so do not rely on it without counsel.

### I4. The agentic layer (orchestrator, interpreter, verifier)

**Recommendation: defer the LLM interpreter until I1 to I3 are decided.** The deterministic orchestrator needs no model and is not affected. A model-written narrative raises the automation-bias and "directs the HCP's judgment" questions under Criteria 3 and 4, so it should start in shadow mode, keep the verbatim engine output as the authority, and carry the plain-language basis Criterion 4 asks for. It is also blocked on a model-provider and BAA decision (gap analysis, G4.1 and G4.2).

### I5. Retention classes, roles and owners

**Open, with counsel.** Retention periods depend on state law and on the records' status; I do not propose numbers. For each record class (patient, report, evaluation, ledger, audit) the decision needs an owner and a period. Role questions: who is the clinician user, who signs off, who owns the clinical content and its release.

## 5. What each decision unlocks

| Slice | Waits for |
| --- | --- |
| M2.4 reviewed knowledge release pipeline | I1 (intended use) |
| M3.1 and M3.2 extraction and review journey | M2.4, I3 |
| G3.1 and G3.2 VCF validation and PharmCAT | I1 b and I2 b (device path) |
| G3.4 and G3.5 knowledge-change proposals, real-gene golden set | M2.4 |
| G5.1 sign-off semantics and step-up | I3, M3.2 |
| G4.1 and G4.2 narrative interpreter and verifier | I4, a BAA and a model-provider decision |
| Data products | I1, plus the license and counsel items in [pgx-data-model-and-data-products.md](pgx-data-model-and-data-products.md), section 7 |

## 6. Questions for counsel

1. Do you agree that the product as described in I1 a is non-device CDS under section 520(o)(1)(E), and can the position be documented (for example, a regulatory memo)?
2. Is a result from a **lab-developed test** "used consistent with FDA-required labeling" for Criterion 2, or does the labeling condition fail for results that have no FDA labeling?
3. Is CPIC's verbatim recommendation wording (for example, an instruction to avoid a drug) "a specific treatment directive" under Criterion 3, or an option set tied to a published guideline? Would a single-option output fall under enforcement discretion here?
4. The product accepts and stores a VCF today with a header-only check and no interpretation. Is that acceptable, and where is the line between displaying a VCF-derived lab result and processing the VCF? What would Criteria 1 and 4 require if a lab later sends VCFs for interpretation?
5. Does licensing the knowledge to third parties, or any data product, change the regulatory position ([pgx-data-model-and-data-products.md](pgx-data-model-and-data-products.md), section 7)?
6. The items already open in that document: state genetic-privacy law including Puerto Rico, anti-kickback treatment of a payer paying per test, and the dual business-associate and contractor role.

## 7. What was and was not verified

- **Read:** FDA's guidance PDF, pages 1 to 3 and 7 to 20 (title and contents, sections IV and V.A to V.B); the statute text of section 520(o)(1)(E) (three conditions plus the lead-in, which the guidance numbers as four criteria).
- **Not read:** the guidance's device examples (section V.C, pages 21 onward), the guidance's background and scope sections (pages 4 to 6), any FDA policy on lab-developed tests, the other FDA digital health policies the guidance links, and any state law. Nothing here was run, and no counsel or FDA was consulted.
- **Not decided:** every item in section 4. This document records no decision.
