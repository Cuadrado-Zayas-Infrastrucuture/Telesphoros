# Plan: a data model for PGx decision data and data products (research-backed)

Status: **draft, awaiting founder review. Plan only: no code, migration, dependency or content change, and nothing here is approved or legal advice.** Snapshot 2026-10-19 against main `ccd4499`. It replaces the pasted "profiting from agentic PGx data" model with a structure checked against primary sources and this repository. Related: the gap analysis in draft PR #177 (decisions D1 to D4), [genomic storage and secondary use](../../genomic-storage.md), [records specification](../records-and-corrections.md).

## 1. Decisions this plan assumes (founder, 2026-10-19)

- The in-house engine over pharmacist-signed knowledge stays the source of truth (D1 = A).
- The product is agentic with clinicians in the loop: a deterministic orchestrator, an interpreter and a verifier; the interpreter explains the engine's result and never decides. Gated by M0.1, a tier amendment, a provider decision, a BAA and an eval suite.
- Merkle roots and blockchain anchoring are out of scope until the founder reopens them.
- **Payer-sponsored testing programs are accepted** (a health plan pays for testing so a clinician can choose a better-fitting treatment than trial and error). Selling patient-level or segment data to payers is **not** accepted by default.
- Billing and paid data products are **not** being built now; this plan only fixes the shape so that today's tables do not block them later.

## 2. What the research found

Confidence: **V** = read in a primary source this session; **S** = from a secondary summary, check before relying; **U** = could not be established.

| # | Finding | Source | Conf. |
| --- | --- | --- | --- |
| R1 | A covered entity may use PHI to create de-identified information, or disclose PHI to a business associate for that purpose. Information de-identified under §164.514(a) and (b) is outside the Privacy Rule. | 45 CFR 164.502(d) | V |
| R2 | HHS: de-identifying PHI is itself a *use*, so a business associate may do it only to the extent its business associate agreement authorizes. | [HHS FAQ 544](https://www.hhs.gov/hipaa/for-professionals/faq/544/may-a-health-information-organization-de-identify-information/index.html) (page returned 403 to my fetch; read through a search summary) | S |
| R3 | A covered entity or business associate may not sell PHI without an authorization. "Sale" means a disclosure for which it receives remuneration from the recipient. Research and some other disclosures are exempt **only** when the sole payment is a reasonable cost-based fee. | 45 CFR 164.502(a)(5)(ii) | V |
| R4 | De-identification is Safe Harbor (listed identifiers removed *and* no actual knowledge the rest could identify) or Expert Determination (a qualified expert documents that the risk is very small). | 45 CFR 164.514(b) | V |
| R5 | A re-identification code may be kept only if it is **not derived from or related to information about the individual**. | 45 CFR 164.514(c) | V |
| R6 | A limited data set can be shared only under a data use agreement, for research, public health or health-care operations, with no re-identification or contact. It is not a commercial sale vehicle. | 45 CFR 164.514(e) | V |
| R7 | Genetic information is health information under the Omnibus Rule, and removing names is not genomic de-identification. | [genomic-storage.md](../../genomic-storage.md) (cites HHS) | repo |
| R8 | California requires separate express consent to transfer genetic data to a third party; Florida requires consent before disclosure, sale or transfer; Virginia requires separate consent to transfer. Puerto Rico: I found a genetic-information employment-discrimination chapter (Title 29, ch. 76) and conflicting reports on its general data-privacy statute, but **no statute on sale of genetic data**. | [Securiti](https://securiti.ai/genetic-privacy-laws/), [Inside Privacy](https://www.insideprivacy.com/health-privacy/several-states-introduce-new-genetic-privacy-bills-in-early-2026/), [PR Title 29 §1352](https://law.justia.com/codes/puerto-rico/title-twenty-nine/part-v/chapter-76/1352/) | S, PR **U** |
| R9 | Anti-kickback exposure: OIG withdrew a 2011 opinion on an EHR data-exchange arrangement where physicians received subscription discounts per referral, and signalled scrutiny of revenue-linked physician payments. | [HealthExec](https://healthexec.com/topics/health-it/medical-informatics/oig-changes-position-hie-vendor-relationship-arrangement), [Nixon Peabody](https://www.nixonpeabody.com/-/media/files/alerts/2026/05/oig-advisory-opinion-physician-royalties-under-heightened-scrutiny.pdf) | S |
| R10 | Published practice for aggregate release: minimum cell sizes (PCORnet 11, PEDSnet 5) and **secondary suppression** so suppressed cells cannot be recovered by subtraction. | [countmaskr](https://cloud.r-project.org/web/packages/countmaskr/readme/README.html) and a research-network summary (indicative, not a standard) | S |
| R11 | CPIC's license page says CPIC content is CC0 1.0, with a request to attribute and to cite URL, access date and version for the database and API. | [CPIC license](https://cpicpgx.org/license/) (redirects to ClinPGx; I read it only through search) | S |
| R12 | ClinPGx and PharmGKB data are CC BY-SA 4.0, and a 2018 PharmGKB post says "Under no circumstances can PharmGKB data be sold for other's private or commercial use". The API page says data is "subject to ClinPGx's Data Usage Policy". | [ClinPGx post](https://blog.clinpgx.org/changes-to-pharmgkb-data-licensing/) (read), [API](https://api.clinpgx.org/) (read) | V for the quotes |
| R13 | **The CPIC (CC0) and ClinPGx (CC BY-SA, no sale) statements conflict, and I could not read ClinPGx's current Data Usage Policy** (the page did not render). PharmVar's terms were also not found. | n/a | **U** |
| R14 | The CPIC database is relational: `gene`, `drug` (key like `RxNorm:2670`), `allele` with a shared `allele_definition`, `guideline` (one logical guideline across updates), `publication`, `recommendation` (guideline, drug, **population**, and a lookup key of phenotypes, activity score or allele status), `gene_result` / `gene_result_lookup` / `gene_result_diplotype`, `pair` (with `cpiclevel`), and `allele_frequency` by population. **There is no separate phenotype table.** Releases follow guideline publications, with no fixed schedule. | [cpic-data wiki](https://github.com/cpicpgx/cpic-data/wiki) | V |
| R15 | FHIR Genomics Reporting STU3: a Genomic Report carries Genotype / Haplotype / Variant observations; the **phenotype is a component of the Therapeutic Implication** observation, linked by `derivedFrom`, with CPIC cited through a RelatedArtifact; recommended actions are `Medication Recommendation` tasks. | [HL7 STU3 PGx](https://hl7.org/fhir/uv/genomics-reporting/STU3/pharmacogenomics.html) | V |
| R16 | FDA's CDS guidance was revised 2026-01-06 and re-issued 2026-01-29. It keeps the four non-device criteria, adds enforcement discretion for a single output when only one recommendation is clinically appropriate, and moves the time-critical limit to criterion 4. Genomic data is not discussed. | [Covington](https://www.cov.com/en/news-and-insights/insights/2026/01/5-key-takeaways-from-fdas-revised-clinical-decision-support-cds-software-guidance), [FDA page](https://www.fda.gov/regulatory-information/search-fda-guidance-documents/clinical-decision-support-software) | S |
| R17 | A covered entity may disclose PHI to another covered entity (a health plan) for that entity's **payment** activities without patient authorization, subject to the minimum-necessary standard. "Payment" includes eligibility and coverage determinations. | [HHS FAQ](https://www.hhs.gov/hipaa/for-professionals/faq/1040/may-a-medicaid-state-agency-share-information-to-identify-enrollees/index.html) and compliance summaries (the eCFR text of 164.506, 164.502(b) and 164.514(d) was not read) | S |
| R18 | GINA Title I: a group health plan or insurer may not request, require or purchase genetic information for underwriting (premiums, eligibility, contract renewal, pre-existing-condition rules), but may obtain the minimum necessary from a genetic test to determine payment of a claim. A treating provider may request a test. | [Epstein Becker Green](https://www.ebglaw.com/news/new-requirements-for-employers-group-health-plans-and-health-insurers-under-the-genetic-information-nondiscrimination-act-of-2008/) and others (2009 to 2010 commentary; current regulation text not read) | S |
| R19 | Medicare has one national PGx coverage policy (warfarin, 2009); MolDX local policies cover PGx testing once the treating physician has narrowed treatment to specific medications, or the patient is on medications with FDA- or CPIC-defined actionable gene-drug interactions, and the result informs the decision. Combinatorial panels are generally not covered. A 2025 review found MolDX covered all 65 drug-gene pairs it examined and private plans covered fewer. | [Noridian MolDX L38335](https://med.noridianmedicare.com/web/jeb/article-detail/-/view/10525/moldx-pharmacogenomics-testing-l38335-r1-effective-august-24-2023), [AJMC 2025](https://www.ajmc.com/view/medical-policy-determinations-for-pharmacogenetic-tests-among-us-health-plans) | S |
| R20 | Anti-kickback treatment of a payer paying per test, and of a vendor that is both a business associate of clinics and a contractor of the payer: **not found** in these searches. | n/a | **U** |

What the research changes in the pasted model:
- **R14 and R15 contradict its `Phenotype` entity and its single-phenotype `Recommendation` key.** In both CPIC and FHIR the phenotype is a *result of a mapping* (and, in FHIR, part of the implication), and recommendations carry a population and a multi-input lookup. This repository's cells (one per combination of phenotypes, verified state, verbatim text) are closer to the standards than the pasted table.
- **R5 invalidates `external_id_hash` as a de-identification token.** A hash of the patient's own identifier is derived from information about the individual.
- **R2, R3 and R6 mean the first gate on any data product is the tenant's contract, not the schema.** The business associate agreement must authorize de-identification, and a sale of PHI, or a limited data set, is not a commercial route.
- **R12 and R13 mean a paid knowledge feed cannot be designed until the source licenses are settled in writing.**
- **R17 to R19 make a payer-sponsored testing program workable, with limits:** payment-purpose disclosures to the plan are permitted and bounded by minimum necessary; the plan may not use the genetic information for underwriting; and eligibility should follow the plans' own clinical policies (a medication decision pending, or an actionable gene-drug pair). R20 stays open for counsel.

## 3. The model: six zones, one-way flow

Each zone has its own access rules. Data moves only **K → P** (read), **P → D** (a consent-gated, de-identifying export), **P → S** (payment-purpose disclosures for enrolled members) and **D → S** (aggregate program reports), and **K, P → A** (by reference). Nothing flows from D, S or C back into P, and C never touches P.

### Zone K: knowledge (global, read-only to the application role, no `tenant_id`)
The signed JSON files remain the source of truth ([cpic-integration.md](../../cpic-integration.md)). A relational **projection** is generated at release for API and analytics use. Every row belongs to one `knowledge_set` (the existing 64-hex `knowledge_set_id`), so any decision can be replayed against the exact content it used.

| Table (projection) | Maps to | Notes |
| --- | --- | --- |
| `knowledge_set` | existing `evaluations.knowledge_set_id` | released_at, signer, status |
| `source_document` | new | publisher (CPIC, DPWG, FDA, PharmVar), version, retrieved_at, **`license` and `redistribution` (allowed / restricted / unknown)** |
| `gene`, `allele`, `allele_definition` | CPIC `gene`, `allele`, `allele_definition` | adds the **PharmVar release** used (the pasted model has no allele-definition version) |
| `gene_result`, `gene_result_lookup` | CPIC `gene_result*`; this repo's diplotype-table, function-pair, activity-score maps | phenotype is a mapping result, not a master entity |
| `drug` | CPIC `drug` | RxNorm id plus name (this repo stores a lower-case name today) |
| `recommendation_cell` | this repo's guideline cell | genes[], `when` per gene, **population**, strength, verbatim text, locator, **verification state, verifier, date** |
| `pair` | CPIC `pair` | `cpic_level` |
| `allele_frequency` | CPIC `allele_frequency` | optional, later; the pasted model's "population insight" |

### Zone P: patient and clinical (tenant-scoped, forced RLS, PHI). Largely exists.
- `patients`, `reports`, `evaluations` (+ `evaluation_gene_states`, `evaluation_results`), the ledger: these already are the pasted model's `PGxTestResult` and `GeneResult`, with the right immutability (append-only, `ON DELETE RESTRICT`, `knowledge_set_id` and `engine_version` on every row). **Do not add a `PatientToken` table**; the pseudonym belongs to zone D, not here.
- **New, needed before any real data: `consent_record`** (tenant, patient, purpose from `clinical-care | research | commercial-aggregate | payer-program`, scope, jurisdiction, form version, granted / expires / withdrawn, a ledger event). Append-only; the default is no consent beyond clinical care. No consent table exists today (only a fixture flag in the SMART pilot).
- **New: `tenant_data_terms`** (tenant, agreement version, which secondary uses the BAA or contract authorizes, de-identification yes/no). Two independent gates (R2, R8): the **tenant's contract** and the **patient's consent**. Both must hold for a record to be exportable.

### Zone D: de-identified data products (separate schema or database, no `tenant_id`, no patient ids, no foreign keys into P)
- Built only by a one-way export job reading P through an audited, read-only role, for records passing both gates, writing generalized values.
- **Tier D1, aggregates** (`agg_gene_phenotype_count`: gene, phenotype, coarse population bucket, n, suppressed flag): small-cell threshold plus secondary suppression (R10); a stated minimum (I propose at least 11 as the default and require the founder and counsel to set it); repeated-query differencing handled by releasing fixed snapshots, not live queries.
- **Tier D2, row-level cohorts:** **not before** a documented Expert Determination (R4) and a data use agreement; generalized ages, no dates, no free text. A limited data set is *not* acceptable for sale (R6).
- A de-identification token, if one is ever needed, is a **random** value stored only in a mapping kept in zone P, never a hash of an identifier (R5). That mapping also records which batch a record joined, so future batches exclude withdrawn consent. A released de-identified batch cannot be recalled; the consent form must say so.

### Zone S: payer-sponsored testing programs (tenant-scoped records in P, plus program-level reporting)
A health plan (the **sponsor**) pays for testing for enrolled members so that a clinician can choose a medication on evidence instead of trial and error. The sponsor is a **customer of a program**, not a buyer of data.

| Table | Zone | Notes |
| --- | --- | --- |
| `program` | C | sponsor (customer), name, term, **eligibility rule version**, the clinical-policy basis it follows (for example a Medicare local policy or the plan's own policy, R19), status |
| `program_eligible_pair` | K reference | the gene-drug pairs the program covers, each pointing at a **verified** knowledge cell; a pair with no verified cell cannot be a program pair |
| `program_enrollment` | P | tenant, patient, program, the patient's **program-sharing consent**, a **keyed digest** of the sponsor's member reference (never the raw value, following `patient_identifiers`), authorization reference, status, dates |
| `program_service` | P | enrollment, the service performed (test completed, interpretation delivered), date, authorization reference; **no genotype or recommendation content** |
| `program_invoice_line` | C | sponsor, program, service, price: settlement is per service **between the sponsor and the service provider**, never to or from ordering physicians |

What the sponsor can receive:
1. **Per member, for payment only (R17, R18):** enrollment and authorization status, whether the service was performed and when. Result content (a genotype or phenotype) is not sent by default; it is shared only if the sponsor needs it for a payment determination, only the minimum, only with the patient's consent.
2. **Per program, as aggregates:** enrollment, completion, turnaround, and outcome measures (for example the number of medication changes after testing), released as zone D1 aggregates with the minimum cell size and secondary suppression. This is the evidence of "less trial and error" the sponsor is paying for.

Rules specific to this zone:
- **Clinical independence.** The sponsor and program tables are never read by the engine, the interpreter or the verifier; a recommendation cannot depend on who pays. A test asserts no engine or agent module imports them. The clinician decides, and a program never gates care on a result.
- **Use limits in the program agreement:** no use of member genetic information or program data for underwriting, eligibility, premium setting, marketing, coverage restriction beyond the agreed clinical policy, or re-disclosure; audit rights; return or destruction at the end (R18; to be confirmed against current GINA regulation text).
- **Consent:** an opt-in per program, withdrawable, recorded in `consent_record` with purpose `payer-program`. Withdrawal stops future disclosures; past disclosures cannot be recalled.
- **Physician side unchanged:** the physician subscription stays flat (C6). No discount, fee or benefit to ordering physicians depends on enrollment or test volume (R9, R20).
- **Dual role:** the clinics (tenants) are covered entities and Telesphoros is their business associate, while a program contract may also make Telesphoros the sponsor's contractor. How those roles and their agreements fit together is a counsel item.

### Zone C: commercial
`product`, `license` (customer, product, term, entitlements), `usage_event` (license, endpoint, count). Keyed to licenses and programs, **never to patients or orders**; a program's invoice lines count services, not people. Starts as the manual contract and invoice ledger already on the roadmap (P1); Stripe automation (P2) later. Pricing to physicians stays flat and tenure-based (the prompt's C6), and no value passes to physicians in exchange for data without counsel (R9).

### Zone A: agent and review (PHI; inside the tenant boundary)
`agent_run` (evaluation id, knowledge_set_id, model id, prompt id and version, tokens, cost), `narrative_artifact` (text, **basis references to recommendation cells**, verifier result), `human_review` (artifact, reviewer, decision, edits). It stores references and tokens, never free-text patient input and never prompts containing PHI in logs. The orchestrator's state is the existing job, outbox and record tables.

## 4. Revenue lines against the model

| Line | Reads | Gate before building |
| --- | --- | --- |
| Knowledge API or feed | Zone K only | **Source licenses settled in writing (R12, R13); M2.4 real signed content; M0.1 regulatory posture (R16).** Per-source `redistribution` flags let a feed exclude restricted sources. |
| Enrichment API for integrators | Zone K and the integrator's own request (no stored patient data) | Same as the clinical product, plus integrator contracts and liability |
| Aggregate statistics | Zone D1 | Tenant terms, patient consent, minimum cell size, volume that does not exist yet |
| Research cohorts | Zone D2 | Expert Determination, DUA, consent, counsel |
| **Payer-sponsored testing program** | Zone P (payment-purpose, per member) and D1 (program aggregates) | **Accepted by the founder.** Needs the program agreement with use limits, patient opt-in, counsel on dual role and anti-kickback (R20), and eligibility tied to verified knowledge cells and the sponsor's clinical policy. |
| Payer data products (segments, cohorts, member-level data for sale) | none | **Excluded until counsel reviews.** A payer holds claims data that makes de-identified rows easier to link (R4: "other reasonably available information"), and genetic information must not reach underwriting (R18). |

## 5. Invariants (each becomes a test when its zone is built)

1. No code path discloses PHI for remuneration (R3).
2. A de-identification code is never derived from an identifier (R5).
3. Zone D has no foreign key, tenant id or patient id back to P.
4. Export requires both gates (tenant terms and patient consent) for the same record at export time.
5. Zone K rows carry a license and a redistribution flag; a feed build refuses `unknown`.
6. Every decision references its `knowledge_set_id`; no recommendation is shown without a cell and a citation (existing rule).
7. Pricing never references order or test volume (C6).
8. Nothing in zones C, D or S can write to P's clinical tables.
9. The engine, interpreter and verifier never read `program`, `program_enrollment` or any sponsor field.
10. A disclosure to a sponsor contains only the payment-purpose fields allowed for that program, and a program aggregate obeys the zone D1 cell rule.
11. A program cannot list a gene-drug pair that has no verified knowledge cell.

## 6. What to do now, and what not to

**Cheap and option-preserving (candidate slices, none started):**
- **K1:** add `license` and `redistribution` metadata to knowledge file provenance, and the PharmVar release to allele-bearing files, before real content is signed (M2.4). Retrofitting after signing means re-signing every file.
- **K2:** extend the knowledge schema to carry `population` and RxNorm id on drugs, following CPIC's model, only if M2.4 needs them.
- **PC1 (done in this document):** the `consent_record` and `tenant_data_terms` designs are sketched in Appendix B, and the counsel and publisher questions are collected in Appendix A for the founder to hand over with the BAA. Nothing has been sent or answered.
- **Tracking:** a one-paragraph note in the BAA checklist that de-identification authority must be explicit (R2).

- **S1:** a separate plan for the sponsored-program zone (agreement template, enrollment and consent flow, payment-purpose disclosure fields, D1 report), after M0.1, real signed knowledge and real consent design; not before any real data.

**Do not build now:** zones C, D and S, a graph database, openEHR or Phenopackets mappings, population-frequency products, any segment or audience table, any hashing scheme for pseudonyms.

## 7. Open items only others can close

- **Source licenses (R12, R13):** ask ClinPGx and CPIC in writing which terms govern the CPIC database and API, and whether a paid knowledge feed built on CPIC content is allowed. Read ClinPGx's current Data Usage Policy and PharmVar's terms directly.
- **Counsel:** the BAA language for de-identification and secondary use; whether the state consent laws apply to your tenants' patients; Puerto Rico's data-protection statute and any rule on genetic data (R8); anti-kickback review of any arrangement that passes value to physicians (R9).
- **FDA (M0.1):** whether processing a lab-supplied VCF is closer to criterion 1 (signals from an in vitro diagnostic) than reading a lab's reported diplotype. The guidance does not address genomic data (R16).
- **Minimum cell size and Expert Determination provider:** founder and counsel decisions.
- **Sponsored programs (R17 to R20):** read the eCFR text of 164.506, 164.502(b) and 164.514(d) and the current GINA Title I regulations; counsel on anti-kickback for a payer paying per test and on the dual business-associate and contractor role; whether aggregate program reports to a sponsor are payment, operations or need de-identified treatment; which sponsor clinical policies apply (R19).

## 8. What this does NOT touch

Code, migrations, knowledge files, CI, Terraform, the roadmap table, the approval tiers, and the gap-analysis plan (PR #177). It records no decision beyond section 1.

## 9. How this was verified

Primary text read: 45 CFR 164.502(d) and (a)(5)(ii), 164.514(a) to (e) (via Cornell LII), the CPIC data wiki, HL7 STU3 PGx page, a ClinPGx licensing post and the ClinPGx API page. Repository facts come from reading `0008_evaluations.up.sql`, [cpic-integration.md](../../cpic-integration.md) and the table list across `migrations/`. Items marked S are secondary summaries (the payer-program rows R17 to R19 are all secondary); items marked U are unresolved. Nothing was run in AWS or against a model provider.

## Appendix A: brief for counsel and for the source publishers

Prepared so the founder can hand it over as is. Each question cites the finding it comes from; none has been answered.

**For counsel**
1. Do the tenant business associate agreements authorize Telesphoros to de-identify PHI, and for which downstream uses (aggregate statistics, research cohorts, payer-program reports)? If not, what wording is needed? (R2)
2. Confirm that no planned arrangement is a "sale of PHI", including fees a sponsor pays Telesphoros for a testing program while payment-purpose disclosures flow to the sponsor. (R3, R17)
3. Which state laws apply to the tenants' patients that require separate express consent before genetic data is transferred, and what does Puerto Rico require, including its general data-protection statute? (R8)
4. How do the roles fit together when the clinics are covered entities, Telesphoros is their business associate, and a program contract makes Telesphoros the sponsor's contractor? Which agreements are needed? (Zone S)
5. Anti-kickback: is a payer paying per test acceptable when the physician subscription stays flat and no value passes to ordering physicians? (R9, R20)
6. Confirm the current GINA Title I text on payment-only access to test results, and the use limits the program agreement must carry. (R18)
7. When is an Expert Determination required (row-level cohorts), who can provide it, and what minimum cell size should aggregates use? (R4, R10)
8. Does an aggregate program report to a sponsor count as payment, operations, or de-identified data? (Zone S)
9. FDA (M0.1): does the intended use stay non-device CDS, does a lab-supplied VCF raise criterion 1, and does licensing the knowledge to third parties change the posture? (R16)

**For ClinPGx, CPIC and PharmVar (in writing)**
1. Which terms govern the CPIC database and API: CC0 as the CPIC license page states, or ClinPGx's Data Usage Policy? (R11, R12)
2. May a paid product redistribute or build on CPIC content, and on ClinPGx or PharmGKB annotations, given "cannot be sold for others' private or commercial use"? (R12)
3. What are PharmVar's terms for star-allele definitions in a commercial product? (R13)

## Appendix B: sketch of the two new patient-zone tables

For design review only; no migration is proposed here. Both follow the repository's append-only, ledgered record pattern: state is derived from later records, never edited, and no row is deleted.

**`consent_record`**: `id`, `tenant_id`, `patient_id` (composite key with the tenant, `ON DELETE RESTRICT`), `kind` (`grant` or `withdrawal`; a withdrawal references the grant it ends), `purpose` (`clinical-care`, `research`, `commercial-aggregate`, `payer-program`), `scope` (for a payer program, the program id), `form_version`, `jurisdiction`, `granted_by` (the person or a recorded representative), `effective_at`, `expires_at` (optional), `ledger_event_id`, `created_by`, `created_at`. Absence of a record means no consent beyond clinical care. The current state for a purpose is the latest record, and a withdrawal ends future disclosures only.

**`tenant_data_terms`**: `id`, `tenant_id`, `agreement_ref`, `agreement_version`, `effective_from`, `effective_to` (optional), `de_identification_authorized` (boolean), `authorized_uses` (a subset of `aggregate-statistics`, `research-cohort`, `payer-program-reporting`), `ledger_event_id`, `created_by`, `created_at`. Written by an operator command like the existing tenant commands, not by a tenant administrator, because it records a contract fact.

**Export gate (zone P to D, and the aggregate reports in zone S):** a record is eligible only if the tenant's latest terms authorize that use at the time **and** the patient's latest consent for that purpose is a non-expired grant at the time. The check runs inside the export transaction so a withdrawal cannot be missed.
