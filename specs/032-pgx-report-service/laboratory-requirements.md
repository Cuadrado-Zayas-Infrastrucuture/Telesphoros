# Laboratory partner requirements

Proposed procurement checklist, not an assay order or validation approval. Request an itemized response with evidence location, laboratory owner, limitation and available reflex path for every row. “Gene included” is insufficient. Do not require every module to launch together.

## Common evidence

- Laboratory identity, applicable accreditation/certification and signed-out-report responsibility; validated intended uses and specimen types; collection, identification, transport, failure/recollection and turnaround procedures.
- Immutable assay manifest with exact alleles, variants, regions and structural classes, assembly/transcripts, strand conventions, nomenclature versions and exclusions. Explain which calls are direct, inferred or unresolved.
- Analytical validation by variant class: accuracy/concordance denominators and confidence intervals, sensitivity/specificity where meaningful, reproducibility, detection limits, interference, sample adequacy, contamination and failure/no-call rates. Separate reference-material consensus calls from non-consensus GeT-RM calls.
- Phase, copy-number and ambiguity reporting policy; confirmatory/reflex methods and their triggers, turnaround and cost. Unresolved results must remain unresolved if reflex testing is unavailable.
- External quality/proficiency assessment, change control, incident handling, amendment notification and access to prior report revisions. Specify contractual notification/reconciliation times; no numerical SLA is assumed here.
- Structured package plus matching selectable-text PDF, stable IDs and explicit missing values as in [contracts](contracts/README.md). Provide synthetic conformance specimens for final, amended, cancelled, partial and no-call reports. Never request personal patient examples for development.
- Partner authenticity, patient/accession/specimen reconciliation and signature/trust arrangements; secure delivery, permitted uses, retention and appropriate agreements. Keep laboratory validation, clinical evidence and software validation as separate sign-offs.

## Target-specific evidence to request

| Target | Required disclosure / candidate procurement requirement |
| --- | --- |
| CYP2D6 | Deletions, duplications, copy-number resolution, hybrid/tandem alleles, phase, pseudogene interference and unresolved-copy cases. AMP Tier 1 includes deletion/duplication; hybrid assessment is Tier 2. More complete resolution is a product procurement choice, not a claim every method is Tier 1. |
| CYP2C9 | At least evaluate coverage for *2, *3, *5, *6, *8, *11 for intended populations; state additional alleles and residual limitations. A limited *2/*3 assay cannot be marketed as comprehensive. |
| CYP2C19 / CYP2B6 / NAT2 | Exact functional and ancestry-relevant allele coverage, phase/haplotype method, ambiguity and current definition versions; obtain a clinical-lead-approved list before contracting. |
| CYP3A5 | Explicit *3, *6, *7 coverage and validated interpretation. |
| DPYD | Evaluate the seven 2024 AMP Tier 1 targets on NM_000110.4: c.1905+1G>A, c.1679T>G, c.1129-5923C>G, c.557A>G, c.868A>G, c.2279C>T, c.2846A>T. Distinguish direct causal HapB3 variant detection from a tag/proxy and disclose residual risk. Verify transcript/coordinates against the laboratory's actual manifest. |
| TPMT / NUDT15 | Combined interpretation inputs; TPMT *1/*3A versus *3B/*3C phase ambiguity; exact NUDT15 coverage. No independent serial dose arithmetic. |
| UGT1A1 | Repeat-length and sequence-variant performance, reference convention and phase where needed; do not assume an SNV-only assay resolves repeat alleles. |
| HLA-A / HLA-B | Explicit resolution and validated detection of HLA-A*31:01 and HLA-B*15:02, *57:01, *58:01 as appropriate; closely related allele interference and residual risk. |
| G6PD | Genetic limitations, mosaicism and measured enzyme-activity method/units/reference interval; relevant hemolysis/transfusion timing. Genetic “negative” alone may not resolve enzyme activity. |
| MT-RNR1 | Exact variants, mitochondrial reference, tissue/specimen, heteroplasmy quantification and detection limit. Do not invent a universally safe heteroplasmy cutoff. |
| RYR1 / CACNA1S | Targeted versus sequencing coverage, variant classes and classification source/version; explicit warning that a negative genetic result does not exclude malignant-hyperthermia susceptibility. |
| CFTR | Exact responsive variants, complex allele/phase handling, classification and current therapy-label mapping; specialist scope. |
| VKORC1 / CYP4F2 / rs12777823 | Direct rs9923231 versus proxy status for VKORC1, CYP4F2 target definitions and rs12777823 coverage; population-specific algorithm prerequisites. |
| SLCO1B1 / ABCG2 | Exact alleles/variants, function-translation definitions and drug-specific interpretation prerequisites. |

## Partner acceptance package

Before activating a module, obtain: approved assay manifest, validation summary, synthetic example package set, documented analytical limitations/reflex path, authenticated exchange agreement, amendment process and approved report language. Run the software scenarios against those synthetic packages. A procurement response or a matching PDF/JSON hash is not clinical sign-off.

Source basis: AMP recommendations and guideline references in [research](research.md). Recheck all target lists against current primary documents and the selected laboratory's method before adopting them as contractual minimums.
