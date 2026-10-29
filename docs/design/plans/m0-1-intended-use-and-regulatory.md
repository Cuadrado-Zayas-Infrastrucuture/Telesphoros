# Plan: M0.1, intended use and regulatory assessment (draft for the founder and counsel)

Status: **draft. The founder decided I1 to I3 on 2026-10-19 as working positions; I4 (rewritten around the existing agentic design) and I5 were confirmed on 2026-10-20, I5 part b with a longest-period rule; counsel's answers are still open.** Snapshot 2026-10-19 against main `ac7bc72`. **This is a plan only: no code, migration, infrastructure or clinical content changes.** It is a working document for the founder and counsel, **not legal advice and not a regulatory determination.** A decision recorded here is the founder's business position; it does not make the product a non-device, and counsel's answers in section 6 can change it. Every FDA statement below was read in the guidance itself; what was not read is listed in section 7.

Decision names from other documents are prefixed here to avoid clashes: **AG-D1 to AG-D8** are the agentic design packet's decisions, **GAP-D1 to GAP-D4** the gap analysis's, and **TIER-D-A1 to TIER-D-A7** the approval-tier draft's.

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
| The agentic layer is designed (router, bounded specialists, director; business work first; read and draft only). A clinical narrative is not part of that design and would be a separate scope | agentic design packet (vault, 2026-10-18); [pgx-data-model-and-data-products.md](pgx-data-model-and-data-products.md) | Business drafting is not a clinical function as designed. A model-written clinical narrative raises the automation and "directs judgment" questions under Criteria 3 and 4 (see I4) |

## 4. The decisions

### I1. Intended use and who the user is

| Option | What it is | For | Against |
| --- | --- | --- | --- |
| **a. Non-device CDS for HCPs, lab-reported results only** | Pharmacists and clinicians review guideline-sourced information about a patient's reported result, with the basis shown | Fits the four criteria as read, if I3 and the open questions come out right; no premarket submission | Depends on counsel's answers; narrow |
| b. A device (a premarket pathway) | Accept the device definition and pursue FDA review | Needed if the product processes VCFs or gives a directive | Heavy cost and time; a different product and quality system |
| c. Research and demonstration only (today) | `clinicalUse: "not-approved"` stays | No regulatory exposure now | No clinical use, no revenue from clinical users |

**Recommendation: a**, stated in writing as the intended use, with c as the status until counsel confirms.

**Decided 2026-10-19 (founder): a**, with c as the operating status until counsel confirms. A working intended use, not a regulatory determination; counsel questions 1 to 3 decide whether a qualifies. The user is a clinician: software that gives recommendations to patients or caregivers is a device (guidance p. 13).

### I2. Supported inputs and reports

| Option | What it is | For | Against |
| --- | --- | --- | --- |
| **a. Lab-reported results only (PDF reports), a named list of supported lab report layouts** | The current design; a VCF stays "accepted, not interpreted" | Stays on the Criterion 2 side | Depends on labs reporting diplotypes |
| b. Also VCF files | Variant files processed by the product, with or without PharmCAT | More input coverage | **Fails Criterion 1 per the guidance, so it needs option I1 b** |

**Recommendation: a.** Treat VCF and PharmCAT (G3.1, G3.2) as device-path work and keep them out of the non-device scope. The list of supported lab layouts is yours to name.

**Decided 2026-10-19 (founder): a**, and VCF uploads stay as they are (accepted, not interpreted) until counsel answers questions 2 and 4. The list of supported lab layouts has not been named. VCF validation and PharmCAT are device-pathway work and are off the build list.

**Amended 2026-10-28 (founder):** *"we will not store raw data, for research purposes a curated database has way more value."* This replaces "VCF uploads stay as they are": a VCF is no longer accepted or stored at all. The report types are `lab-pdf` and `structured`, where `structured` is a curated JSON report that is stored only and never interpreted. A database CHECK, the intake validator and the upload schemas refuse VCF. A database that already holds a VCF report refuses the migration, because no row is rewritten. This keeps the product further from Criterion 1 (VCF files are named as "patterns" on page 8; example 17 on page 24). The research brief of 2026-10-28, checked against the guidance, is recorded in spec 014's research notes.

### I3. How a recommendation is shown

| Option | What it is | For | Against |
| --- | --- | --- | --- |
| **a. Guideline-sourced information with the citation and options, never a standalone directive** | The engine's verified wording shown as what the named guideline says for this result, with the basis and what is missing | Aims at Criteria 3 and 4 | Counsel must confirm the verbatim wording is not a directive |
| b. A single directive ("do X") | | Simplest to read | Fails Criterion 3 as read; falls to the device path unless enforcement discretion applies |

**Recommendation: a.** The enforcement-discretion route (one clinically appropriate option) is narrower than it looks: it excludes time-critical uses and genomic inputs without established relevance, so do not rely on it without counsel.

**Decided 2026-10-19 (founder): a**, pending counsel question 3. The product never shows a bare "do X": it shows the source, the options where the guideline gives them, and what is missing. A presentation rule is not a legal safe harbor, and enforcement discretion is not relied on.

### I4. The agentic layer

The product is agentic by design, and agents are meant for business work (support, operations, billing) as well as clinical work. **A design for this already exists** (founder-confirmed direction of 2026-10-18, in the vault's agentic design packet and status map). This section does not replace it. It says what M0.1 adds: which parts the regulatory assessment gates and which it does not.

**What the existing design already decides** (not restated as new decisions):

- **Topology:** a router, three bounded specialists and a director on a fixed 14-node graph. Trusted code selects every edge; models never do.
- **First scope is business work:** staff SOP and FAQ help and support drafts, on synthetic company documents, English and Spanish evaluated separately (AG-D1). Models are self-hosted open-weight models, and the existing PostgreSQL job queue is reused.
- **Authority is read, summarise and draft only** (tier T0, AG-D5). Writes need a separate approval design. The approval-tier draft's 15-minute silence window for T1 is **not adopted**.
- **Build order:** P1, a memory-only synthetic kernel with model execution disabled, then P2, a durable PostgreSQL fixture slice. No model, host or spend is approved (AG-D7 is open).
- **Clinical work and write-capable agents are separate scopes.**

**What M0.1 adds:**

| Lane | What the agent does | What M0.1 says |
| --- | --- | --- |
| **Business** (support and SOP drafts, later operations and billing) | Drafts and summarises for staff; no patient-specific clinical output | Not gated by the device question **as designed**. *Assumption for counsel to confirm:* business documents never carry patient-specific clinical content. Its gates are AG-D6 and AG-D7 and the approval tiers. |
| **Clinical narrative** (a labelled, non-authoritative explanation beside the verbatim recommendation; GAP-D2 option B) | Drafts text about a patient's result | **A separate later scope, not started.** It sits behind I1 to I3, which are decided, and the gates below. |
| **Writes and effects** (customer messages, billing, record changes) | Proposes actions for a named approver | Tier T2 or higher, behind TIER-D-A1 to D-A7, which are open. Billing is out of scope for this program (GAP-D3). |

**Gates for the clinical narrative** (all open):

1. Counsel's answer on whether a model-written narrative changes the Criterion 3 and 4 position. FDA weighs the level of automation and automation bias (guidance pp. 14 to 15). This is new counsel question 7 below.
2. An amendment to the approval tiers: today T3 puts "anything touching clinical results" out of the agent's reach entirely, so a draft narrative needs an explicit, narrower rule (the agent may draft, never decide).
3. A hosting decision with data flow settled: either a self-hosted model, so no patient data leaves the platform, or a third-party provider with an executed BAA (none exists; synthetic data only until then).
4. Shadow mode first, an eval suite with before and after scores, and the plain-language basis Criterion 4 asks for. The verbatim engine output stays the authority, and the narrative never replaces it (GAP-D2 option C is not an option).

**Recommendation:** keep building the business lane under the existing design; open the clinical narrative as its own scope only after gates 1 and 2; keep the product's clinical authority in the verbatim engine. **Confirmed 2026-10-20 (founder), as written.**

### I5. Retention classes, roles and owners

**What the repository already holds (not re-decided here):**

| Class | What exists today | Where |
| --- | --- | --- |
| Patient and clinical records | Kept indefinitely; the application has no delete path | [records-and-corrections.md](../records-and-corrections.md), section 10 |
| Evaluations (structured results) | Part of the clinical record: they follow retention policy and legal holds, never erasure | same, redaction scope |
| Free-text notes | The only redactable class; a redaction is ledgered (who, when, basis) | same |
| Report and source files | Noncurrent versions kept at least six years (a Terraform validation enforces the floor); the 2026-10-19 decision adds a six-year (2,190 days) GOVERNANCE Object Lock in production | same, item 5; hardening decisions |
| Audit bucket | COMPLIANCE Object Lock in production, as a precondition; synthetic stays GOVERNANCE | hardening decisions |
| Roles | `clinician`, `admin` (administration only, no clinical data), `reviewer` (additive, never implied); a member with no role can only call `/me` | [auth.md](../../auth.md) |

[genomic-storage.md](../../genomic-storage.md) asks for one row per record category (authority, responsible party, trigger date, period, hold, approved disposal process) before any operational change. HIPAA's six years covers compliance documents, not clinical records; CLIA sets a two-year minimum for specified laboratory records; ACMG recommends considering five years for VCF files and final reports. Which of these applies, including Puerto Rico and federal law, is unresolved.

**Decided 2026-10-20 (founder):**

- **a. Retain everything.** No deletion, disposal path or retention job is built until each class has a complete row.
- **b. Longest period.** For each class the period is the **longest** that any applicable authority or contract requires ("most strict" means longest). The working floor stays six years (2,190 days). Counsel decides any privacy-law cap; a cap or a deletion-on-request right can conflict with a long period, and that conflict goes to counsel question 6, not to a default.
- **c. Roles.** Keep the three roles and add none until a feature needs one. Customer-message and billing roles are undefined (TIER-D-A1) and sign-off semantics are open (G5.1).
- **d. Owners.** The founder owns every seat until named: the clinical content and release owner (M2.4), the privacy and security reviewer and corpus publisher (AG-D6), and the second approver (TIER-D-A7). **Consequence:** with one named person, four-eyes approvals and tier downgrades stay blocked, by design.

**Still open:** a retention period for backup copies (none found in the documents read), whether a merged patient's records must stay individually retrievable, legal holds, and the periods themselves (counsel).

## 5. What each decision unlocks

| Slice | Waits for |
| --- | --- |
| M2.4 reviewed knowledge release pipeline | I1 (intended use) |
| M3.1 and M3.2 extraction and review journey | M2.4, I3 |
| G3.1 and G3.2 VCF validation and PharmCAT | I1 b and I2 b (device path) |
| G3.4 and G3.5 knowledge-change proposals, real-gene golden set | M2.4 |
| G5.1 sign-off semantics and step-up | I3, M3.2 |
| G4.1 and G4.2 clinical narrative and verifier | I4 gates 1 to 3 (counsel, tier amendment, hosting and BAA decision) |
| Data products | I1, plus the license and counsel items in [pgx-data-model-and-data-products.md](pgx-data-model-and-data-products.md), section 7 |

## 6. Questions for counsel

1. Do you agree that the product as described in I1 a is non-device CDS under section 520(o)(1)(E), and can the position be documented (for example, a regulatory memo)?
2. Is a result from a **lab-developed test** "used consistent with FDA-required labeling" for Criterion 2, or does the labeling condition fail for results that have no FDA labeling?
3. Is CPIC's verbatim recommendation wording (for example, an instruction to avoid a drug) "a specific treatment directive" under Criterion 3, or an option set tied to a published guideline? Would a single-option output fall under enforcement discretion here?
4. The product accepts and stores a VCF today with a header-only check and no interpretation. Is that acceptable, and where is the line between displaying a VCF-derived lab result and processing the VCF? What would Criteria 1 and 4 require if a lab later sends VCFs for interpretation?
5. Does licensing the knowledge to third parties, or any data product, change the regulatory position ([pgx-data-model-and-data-products.md](pgx-data-model-and-data-products.md), section 7)?
6. The items already open in that document: state genetic-privacy law including Puerto Rico, anti-kickback treatment of a payer paying per test, and the dual business-associate and contractor role.
7. The planned clinical narrative is a model-written explanation shown beside the verbatim recommendation, always labelled and never the authority. Does it change the Criterion 3 and 4 position, given FDA's attention to the level of automation and automation bias? Does it matter whether the model is self-hosted or run by a third party?

## 7. What was and was not verified

- **Read:** FDA's guidance PDF, pages 1 to 3 and 7 to 20 (title and contents, sections IV and V.A to V.B); the statute text of section 520(o)(1)(E) (three conditions plus the lead-in, which the guidance numbers as four criteria).
- **Not read:** the guidance's device examples (section V.C, pages 21 onward), the guidance's background and scope sections (pages 4 to 6), any FDA policy on lab-developed tests, the other FDA digital health policies the guidance links, and any state law. Nothing here was run, and no counsel or FDA was consulted.
- **Also read (2026-10-20):** the vault's agentic design README, status map and durable-execution note, and the gap analysis and approval-tier draft in this repository. **Not read:** the packet's `design.md`, contracts, budgets, Harness² pilot and report review, and the P2 packets.
- **Decided, as working positions only:** I1, I2 and I3 (founder, 2026-10-19); I4 and I5 (founder, 2026-10-20). **Open:** every counsel question, the retention periods themselves, and the named owners.
- **Also read for I5 (2026-10-20):** `genomic-storage.md` (retention authorities), `records-and-corrections.md` section 10 and item 5, and the roles table in `auth.md`. **Not read:** `ops/report-evidence.md`, the backup decision sheet for any backup-copy retention, and any state law.
