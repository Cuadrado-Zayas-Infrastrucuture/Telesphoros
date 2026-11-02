# Candidate coverage matrix — design revision 2026-11-02

**Activation: zero clinical pathways approved by this proposal.** This is a medication-pathway planning matrix, not an exhaustive export of CPIC pairs or recommendation cells. CPIC data **v1.61.0** is the proposed reconciliation baseline, together with publications, supplements and notices available by 2026-11-02. A full pair/cell reconciliation has not been performed. Upstream version and the eventual Telesphoros knowledge snapshot must be recorded separately.

## Catalogue and sequencing

| Module | Candidate genes/locus | Proposed sequence |
| --- | --- | --- |
| Common metabolism | CYP2D6, CYP2C19, CYP2C9, CYP2B6 | Start with a bounded medication list chosen with the clinical lead and lab. |
| Cardiovascular | SLCO1B1, ABCG2, VKORC1, CYP4F2; rs12777823 | Statin pathways first; warfarin requires more context and assay coverage. |
| Treatment-specific metabolism | CYP3A5, UGT1A1, NAT2 | Activate only with the corresponding treatment service. |
| Oncology/immunosuppression | DPYD, TPMT, NUDT15 | Combined-gene rules and interim-guidance governance before activation. |
| Other safety | HLA-A, HLA-B, G6PD, MT-RNR1 | Separate allele/activity/mitochondrial input contracts. |
| Specialist extension | RYR1, CACNA1S, CFTR | Specialist interpretation and additional validation. |

This is 21 unique genes plus one locus. It is not a universal ordering panel. Lab platform, clinical indication and reimbursement determine ordered modules independently of what the schema can represent.

## Medication pathways to reconcile

Every row below is **candidate / not validated / inactive**. Drugs grouped in a row must become individual drug–result–context rows before promotion. Examples define the work to audit; they do not copy dosing recommendations. Required input means a qualified, reviewed laboratory call with provenance and adequate coverage; variants/VCF are optional unless a specific rule requires them.

| ID | Medication or pathway | Genetic inputs | Scope / prerequisite to resolve | Assay dependency / future cases |
| --- | --- | --- | --- | --- |
| C01 | Clopidogrel | CYP2C19 | Indication-specific cardiovascular and neurovascular recommendations; verify exact indication. | Diplotype/phenotype; A01–A03, A13 |
| C02 | SSRIs/SNRIs with published guidance | CYP2D6, CYP2C19, CYP2B6 as required for the individual drug | Enumerate exact drugs; combined CYP2C19/CYP2B6 sertraline handling; no class-wide inheritance. | Copy number/phase and joint-rule support; A04, A07, A12 |
| C03 | Tricyclic antidepressants | CYP2D6, CYP2C19 | Exact drug, indication/dose context and joint tables. | Combined interpretation; A07, A13 |
| C04 | Atomoxetine | CYP2D6 | Age and clinical response context; exact published population. | CYP2D6 resolution; A04, A13 |
| C05 | Codeine, tramadol and other opioids reviewed by CPIC | CYP2D6 | Separate drugs with actionable guidance from insufficient/no-recommendation findings. | CYP2D6 resolution; A04, A19 |
| C06 | Proton pump inhibitors with guidance | CYP2C19 | Drug, indication and treatment duration; no extension to unlisted agents. | CYP2C19 coverage; A03, A13 |
| C07 | NSAIDs with guidance | CYP2C9 | Individual drug, treatment duration, age/organ-function cautions. | Ancestry-inclusive allele coverage; A03, A13 |
| C08 | Phenytoin/fosphenytoin | CYP2C9, HLA-B | HLA-B*15:02 status and metabolism are distinct considerations; history matters. | HLA allele resolution and CYP2C9; A06, A07 |
| C09 | Efavirenz | CYP2B6 | Exact population and regimen; required clinical context. | CYP2B6 coverage; A03, A13 |
| C10 | Methadone | CYP2B6 | Preserve standard-prescribing versus no-recommendation cells; no automatic genotype-based dose/QT change. | Phenotype-specific source review; A19 |
| C11 | Metoprolol | CYP2D6 | Do not extend to every beta-blocker. | CYP2D6; A04, A12, A13 |
| C12 | Ondansetron, tropisetron | CYP2D6 | Reconcile Oct 26 correction against publications and machine tables. | Upstream omission/correction audit; A11 |
| C13 | Statins with guidance | SLCO1B1, ABCG2, CYP2C9 as required for the individual drug | Exact statin and dose; drug-specific/combined tables. | Allele coverage, joint cells; A07, A13 |
| C14 | Warfarin | CYP2C9, VKORC1; CYP4F2 and rs12777823 where applicable | Algorithm/version, clinical factors and population-specific evidence; do not infer ancestry from language or identity. | Direct VKORC1 target, broad CYP2C9, locus coverage; A03, A13 |
| C15 | Tacrolimus | CYP3A5 | Transplant setting and therapeutic drug monitoring; distinguish donor/recipient where relevant. | *3/*6/*7 and sample identity; A02, A13 |
| C16 | Atazanavir | UGT1A1 | Bilirubin-related tolerability and clinical context. | Repeat/sequence coverage; A05 |
| C17 | Oral hydralazine | NAT2 | Adults with resistant hypertension; insufficient guidance for heart failure; wrong route is outside this pathway. | NAT2 haplotype/phase; A13 |
| C18 | Fluoropyrimidines | DPYD | Drug/route and intended regimen; adjudicate variant-specific HapB3 interim notice before activation. | Expanded DPYD coverage and missing-variant disclosure; A03, A08 |
| C19 | Azathioprine, mercaptopurine, thioguanine | TPMT AND NUDT15 | Joint phenotype rule, drug and indication; never multiply independent dose adjustments. | TPMT phase, both genes; A05, A07 |
| C20 | Abacavir | HLA-B*57:01 | Exact allele and prior reaction context. | Validated allele detection; A06 |
| C21 | Carbamazepine / oxcarbazepine | HLA-B*15:02; HLA-A*31:01 where drug-specific guidance applies | Do not transfer HLA-A recommendation between drugs without evidence. | HLA resolution; A06, A13 |
| C22 | Allopurinol | HLA-B*58:01 | Clinical context and negative-test limitations. | HLA resolution; A06 |
| C23 | Drugs reviewed for G6PD risk | G6PD; measured activity where needed | Enumerate drugs/risk categories individually; activity, transfusion/hemolysis and mosaicism can matter. | Activity units/time/method plus genetic limitations; A03, A13 |
| C24 | Aminoglycosides | MT-RNR1 | Exact drug/exposure context; no universal safe heteroplasmy threshold. | Specimen, reference, heteroplasmy detection limit; A06 |
| C25 | Triggering anesthetics / succinylcholine | RYR1, CACNA1S | Specialist malignant-hyperthermia assessment; negative panel does not exclude susceptibility. | Variant-class coverage/classification; A06 |
| C26 | Ivacaftor | CFTR | Current label, responsive variant and age; no automatic extension to combination modulators. | Exact variant identity and classification; A13 |
| C27 | Tamoxifen | CYP2D6 | Exact breast-cancer setting, treatment intent and interacting medications; do not extend to all endocrine therapies. | CYP2D6 resolution and context; A04, A12, A13 |
| C28 | Voriconazole | CYP2C19 | Age-specific guidance, indication and therapeutic drug monitoring context. | CYP2C19 coverage; A03, A13 |

## Explicit boundary rows

| Boundary | Disposition for this proposed service |
| --- | --- |
| HTR2A/SLC6A4 antidepressant prescribing; COMT/OPRM1 opioid dosing | Do not activate a prescribing rule on these associations alone. Preserve imported lab findings if present. |
| UGT1A1/irinotecan | Separate evidence/label pathway; do not count as CPIC coverage through atazanavir. |
| IFNL3/IFNL4 peginterferon | Preserve historical findings and retired assessments; exclude retired pairs from active prescribing coverage. |
| Drug without an applicable reviewed guideline | Explicit outside-scope/no-guideline result; absence of an alert does not imply safety. |

## Required release audit

A release row must contain: stable coverage ID; source pair IDs; drug code/system/version; route/formulation; indication; population predicates; exact required genes/loci and input types; assay manifest/target dependencies; nomenclature/translation version; guideline ID/version and cell locators; CPIC pair level; recommendation strength; source notices/conflicts; local snapshot hash; status/reason; independent case IDs/results; clinical reviewer and approval time.

1. Freeze source pair, drug, guideline, phenotype and recommendation inventories plus retirement records for a dated upstream snapshot. Preserve original downloads, hashes and retrieval time, including pagination/completeness evidence. Reconcile publications and supplemental notices; the live API cannot serve as an immutable release.
2. Expand C01–C28 to exact drug/context/cell rows. Classify every upstream item as supported, no recommendation, retired, excluded with reason, or unresolved. Do not discard unlisted genes/drugs just to make the denominator fit the catalogue. An independent reviewer resolves discrepancies.
3. Confirm every required target/variant class against the selected lab manifest and translation definitions. A gene on the assay does not establish every allele is covered. Unknown manifest means unknown analytical coverage.
4. Validate each supported row with independently authored positive and negative clinical cases and software acceptance cases. Approve a bounded clinical intended use and publish the exact supported list.
5. Report separate measures: supported reviewed decision rows / eligible in-scope rows; resolved tested findings / attempted findings; interpretable findings / released findings; and assessments available in time / eligible encounters. Publish excluded/unknown counts and denominator definitions. Deduplicate repeated reports, revisions and follow-ups. None measures clinical utility by itself.

This design does not yet populate a promoted release manifest or assert a complete CPIC denominator. Those artifacts are a deliverable of the content-validation slice, not something inferred from this table.
