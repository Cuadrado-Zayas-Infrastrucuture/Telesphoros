# Plan: use eligibility (D05), design only

**Status**: approved by the founder on 2026-10-29: E1 to E8 accepted as recommended. Only E1a and E1b are authorized; E2 and E3 are not. Spec: [spec.md](spec.md). Tasks: [tasks.md](tasks.md).

## What exists today (read at `main` `b7edea6`)

- **No consent, grant, terms or restriction table.** Spec 006 research row R15 says only a fixture flag exists, in the SMART pilot.
- **The sketches** are `consent_record` and `tenant_data_terms` (2026-10-19 plan, Appendix B). Both use "latest consent at the time", which this plan replaces with intervals (FR-02).
- **The pattern to copy** is spec 006's `cdr-eligibility-v1`:
  - a named, versioned policy;
  - computed in one statement;
  - read after the lock that competing writes also take;
  - the version stored with the answer.
- **The pipeline refuses production**, so every row is synthetic by construction (R21). There is no data-origin field yet.

## Design

### Records (all append-only, ledgered, tenant-scoped, FORCE RLS, written as the existing record kinds are)

| Record | Holds | Who writes it |
| --- | --- | --- |
| `use_grant` | patient, purpose, scope (for example a program id), jurisdiction, form version, `effective_from`, `expires_at` (optional), granted-by kind (patient, representative or attested form) and reference | clinic staff through the API (a later slice), with the role chosen in E5 |
| `use_withdrawal` | the grant it ends, `effective_at`, recorded-by | the same, and never back-dated past its recording time |
| `use_restriction` | patient, purpose or all, interval, reason code (a patient-requested restriction, or a jurisdiction rule) | clinic staff |
| `tenant_use_terms` | agreement reference and version, interval, authorized uses, `de_identification_authorized` | an operator command, never a tenant administrator (as Appendix B proposed) |

Facts gain a `data_origin` (`synthetic`, `real`) where they are created. Today that means reports and evaluations. It is a small migration of its own and is listed as slice E1a.

### The policy `use-eligibility-v1`

One SQL function, `use_eligibility(tenant, patient, purpose, scope, at)`. It returns `eligible`, the reason codes, and the record ids it relied on. A record is eligible when all of these hold:

1. a `tenant_use_terms` version in force at `at` authorizes the purpose;
2. a `use_grant` for the purpose and scope is in force at `at`: `effective_from <= at`, not expired, and not ended by a withdrawal effective at or before `at`;
3. no `use_restriction` covers the purpose at `at`;
4. the purpose has a jurisdiction rule recorded for the patient's jurisdiction. An unknown rule fails closed, and E4 decides the list;
5. the fact's `data_origin` is allowed for the purpose (FR-07).

Grants and withdrawals for one patient serialize on a per-patient lock. A use that runs in a transaction takes that lock, then calls the function in a fresh statement (FR-04).

### What D07 (release) will consume, and what it must still add

D07 receives only (record, answer, policy version, evidence ids). Release-level controls stay D07's job and counsel's: minimum cells, overlap and differencing control, and the de-identification method. As the founder put it, *"Aggregation alone will not resolve release privacy."*

## Founder decisions

E1 to E8 were accepted as recommended on 2026-10-29. Building is authorized for E1a and E1b only.

| # | Decision | Recommendation |
| --- | --- | --- |
| E1 | **Purposes, and what else each decision records** | Keep the purposes: `clinical-care`, `tenant-quality-improvement` (the tenant's own operations, where generalizable knowledge is not the primary aim), `research`, `commercial-aggregate` and `payer-program`. Add `model-evaluation`, `model-training` and `cross-client-product-improvement` as explicit purposes **if** any is planned, never hidden inside quality improvement. A purpose is only one field: each decision also records the **legal authority** (permitted TPO, authorization or documented waiver), the **data classification** (identifiable, coded, limited data set or de-identified; aggregation alone does not change it), the **parties** (acting-for entity, source tenant, recipient), the **contract** (BAA and service-schedule versions) and the **release conditions**. Optional research and commercial uses can never become a condition of care. |
| E2 | **Intervals vs latest row** | Intervals (FR-02). Needed so any past answer can be reproduced. |
| E3 | **Expiry** | There is no universal default. A grant's expiry is one of: a date, an event (for example the program's end), or an explicitly approved research **no-expiration** mode. A missing value is invalid, never "indefinite". Each authorization type gets its rule from counsel's form matrix (Q6). Materially different purposes are separate choices in a versioned patient packet. |
| E4 | **Jurisdictions** in v1 | An **allowlist** of jurisdiction and purpose pairs, approved for the intended flows. It is chosen from actual clinic commitments and patient and data flows, not from the founder's residence or the place of incorporation. Puerto Rico rules apply where Puerto Rico people, operations or flows are actually in scope. The targeted map in the research notes (Florida, Massachusetts, New York, Alaska, California and Puerto Rico) scopes counsel's work; it is not clearance. Unknown geography blocks the affected secondary export. |
| E5 | **Who signs and who records** | Recording is not signing. Each grant stores `signer`, `signer_capacity` (patient or legally authorized representative, with the authority evidence), `recorded_by`, `witness_or_attester` and `validated_by`. It also keeps the signed document, or an immutable reference to it, with the terms version, language, signature and intake times, scope, recipients and expiry, and proof the patient received a copy. A hash alone cannot prove what was signed. A grant is **recorded but not active** until validated. Staff attestation is allowed only where a statute provides for it (for example Massachusetts ch. 111 §70G for laboratories). For exchange, grants map onto FHIR Consent and provenance onto Provenance; that mapping is for export only. |
| E6 | **Withdrawal** | On receipt, hold the affected secondary processing, cancel pending work, and recheck eligibility before **every** release, at the final hand-off. Staged aggregates are recomputed or excluded as the policy says; an aggregate derived before the withdrawal is not thereby cleared for later release. Any reliance exception (research integrity, a required record) is recorded with its legal basis, approver and scope. HHS limits research reliance to protecting the study's integrity and allows no new information after revocation (HHS FAQ; counsel confirms the current rule, Q8). The platform's intake time and the covered entity's receipt time are kept separately. "Cannot guarantee recall" is not "no further duty": duties to notify recipients, delete accessible copies or mitigate stay as the law sets them. |
| E7 | **Provenance, not a single origin string** | Add a provenance record now (E1a): source organization and type; clinical, research or direct-to-consumer context; originating document and version; collection location; receipt time; whether the interpretation is lab-assigned or software-derived (a lab-reported diplotype or phenotype versus anything Telesphoros derives); the transformation history; and the parent assets. `synthetic` or `real` is one field of it. Provenance links to permissions and never encodes them. It also records the FDA input boundary: what the lab interpreted versus what the software did. |
| E8 | **Slicing** | E1a: data origin. E1b: the four records and the function, synthetic only. E2: operator command for tenant terms. E3: the API for grants and withdrawals, after counsel's form. D07 consumes E1b. |

## U.S. first, LATAM later (founder, 2026-10-28)

The company incorporates in the U.S., and expansion into Latin America comes later. Incorporation does not decide where health or genetic data may be collected, accessed or used. Each decision therefore records the facts that do:
- the patient's residence at the relevant time;
- where the specimen was collected;
- the clinic's, the laboratory's and the recipient's locations, and the recipient's role;
- the processing, storage and access countries;
- the transfer mechanism and contract version.

A **cross-border** release needs two separate yes answers: the use is eligible, **and** the transfer is permitted. An unknown country, or missing transfer evidence, blocks the affected secondary export. Clinical-care access follows its own approved policy. Policies are country profiles added one market at a time. There is no single regional consent template, and no automatic pooling of subsidiaries' patient-level data into a U.S. dataset. HIPAA de-identification is not worldwide clearance.

## Questions for counsel

None of these has been sent or answered. The first five restate Appendix A of the 2026-10-19 plan; the rest are new with this design.

1. Do the tenant BAAs authorize de-identification, and for which uses? (Appendix A, question 1)
2. Is any planned arrangement a sale of PHI? (A2)
3. Which state laws require separate express consent for genetic data, and what does Puerto Rico require? (A3)
4. What are the roles when Telesphoros is both a business associate and a program sponsor's contractor? (A4)
5. When is an Expert Determination required, and what disclosure controls should aggregates use? (A7)
6. Must a grant for research or commercial-aggregate use expire, and may one form cover several purposes?
7. May clinic staff attest a paper form, and what must the record hold to prove it?
8. Does a withdrawal oblige removing a patient from **unreleased** derived aggregates, or only from future extractions?
9. Is `quality-improvement` (the tenant's own operations) usable without a patient grant, as health-care operations, and with what limits?
10. How long must grants, withdrawals and terms be retained, and may any be erased?
11. **EKRA and remuneration (new).** Does any payment to laboratories, clinics, physicians, patients, intermediaries or the platform fall under 18 USC 220, the anti-kickback statute, Stark or state law? This needs the full inventory of money and data flows.
12. **Cross-border use (new, for later LATAM expansion).** For each selected country, does the use have a valid local legal basis, and is the transfer permitted (for example Brazil's LGPD Art. 11 and 33 with ANPD Res. 19/2024, Mexico's 2025 LFPDPPP, or Colombia's Law 1581/2012)? Those countries are illustrations from the research brief, not chosen markets.

## Research notes for counsel (2026-10-28)

The founder supplied two AI-assisted research briefs on 2026-10-28. The second, *Telesphoros Specs 013 014 Research Brief*, cites primary law, regulation and standards for nearly every claim. Load-bearing claims from both were checked at the primary source where one could be reached, and the rest are graded below. The second brief **overturned two findings from the first**, on GINA payment access and Puerto Rico Ley 107-2013; both are corrected here. None of this is legal advice, and every row stays a question for counsel.

| Point | Finding | Source strength |
| --- | --- | --- |
| Q1 de-identification | A covered entity may disclose PHI to a business associate to create de-identified information. There are two methods: Expert Determination and Safe Harbor (removing 18 identifiers). The BAA must permit the use. | HHS guidance summary (secondary). The 2026-10-19 plan read 164.502(d) and 164.514 directly. |
| Q2 sale of PHI | 164.502(a)(5)(ii) prohibits sale except under 164.508(a)(4). The full list of exceptions was **not** retrieved. | eCFR (primary) for the rule. The exceptions are unverified. |
| Q3 Puerto Rico | **Corrected 2026-10-28.** Ley 107-2013 is **not** employment-only. Its Article 4 ("Cobertura por planes de salud", 29 LPRA §1354) bars health plans and insurers from denying coverage on genetic predisposition, requiring genetic information for eligibility or premiums, using it for coverage or benefit decisions, or requiring a genetic test. This was read in the Labor Department's compilation, revised 2020-12-11. Ley 194-2000, Article 11, holds written-authorization and purpose limits for health-information disclosures. Ley 111-2005 is breach notification only, and Ley 39-2012 is a privacy-policy notice law; neither is a lawful-basis regime. No comprehensive privacy statute was found in force. | Primary text read for 107-2013; the others are cited to the government compilations (second brief, refs 33-36). |
| Q3 states | The only multi-state survey found is NCI's, as of 2004, which is **historical**. Montana's Genetic Information Privacy Act requires express consent to transfer. | Secondary. A current survey is needed. |
| Q5 disclosure control | HHS sets no numeric risk threshold. Small-cell suppression and noise against overlapping outputs are practitioner views. | Secondary. |
| Q6 broad consent | The Common Rule's broad consent (45 CFR 46.116(d)) applies only where the Common Rule applies. | Secondary (PMC article). |
| Q9 operations | Treatment, payment and operations are permitted, subject to minimum necessary. Whether Telesphoros's use counts as the tenant's operations depends on the BAA. | Archived HHS text (pre-Omnibus) and Cornell LII. |
| Q10 retention | HIPAA documentation is kept 6 years from creation or last effective date (164.316(b)(2)(i)). Medical-record retention is set by state law. | Cornell LII (primary text). |
| Anti-kickback and EKRA | OIG's lab fraud alert and Advisory Opinions 14-03, 10-23 and 10-24 criticize per-order or per-test fees that vary with volume. Flat physician pricing does not settle the remuneration question. **EKRA (18 USC 220)** separately covers remuneration for laboratory referrals beyond federal programs. Its employee and contractor exception restricts pay that varies with referrals or tests. The personal-services safe harbor (42 CFR 1001.952(d)) has its own conditions. | Law-firm summaries and the statute and CFR as cited (second brief, refs 45-47). |
| GINA (payer access) | **Corrected 2026-10-28.** 42 USC 300gg-4(c)(3) lets a plan or issuer obtain and use "the results of a genetic test in making a determination regarding payment", but it "may request only the minimum amount of information necessary". 45 CFR 146.122 separates results needed for a payment determination from demanding results merely to reimburse the test. Underwriting stays prohibited (300gg-53, and 164.502(a)(5)(i) for health plans), and patient authorization cannot permit it. The 2026-10-19 plan's R18 wording stands; the earlier "no payment-only provision" note was wrong. | 300gg-4(c)(3) read at Cornell LII (primary statute text). 146.122 is cited to the eCFR. |
| Source licenses | CPIC states CC0. ClinPGx and PharmVar content is CC BY-SA 4.0 (share-alike). **On 2026-10-28, `cpicpgx.org/license` redirected to ClinPGx's Data Usage Policy**, which strengthens the conflict. Its text did not load. HHS holds CPIC as a service mark. | The redirect was observed directly. The rest is secondary, including a third-party CDN mirror of the ClinPGx API terms, which is weak. |

Sources the brief relied on that should **not** be cited as authority are archived HHS pages from 2008-09, blog summaries, and a clinic's policy PDF. They are useful as leads only.

## Not touched

Code, migrations, tests, the engine, knowledge, CI and infrastructure. Spec 006 and its `cdr-eligibility-v1` are not touched. The 2026-10-19 plan is kept as history; this spec supersedes only its "latest consent" rule.

## How this was checked

Every table and pattern named under "What exists today" was read at `main` `b7edea6`, using `git ls-tree` and `git show` on the migrations and the plans. No legal statement here is new: each is either a question for counsel or a finding of the 2026-10-19 plan, cited with its original verification flag.
