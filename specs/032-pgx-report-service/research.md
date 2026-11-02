# Evidence register and review limits

Evidence date: 2026-11-02. The supplied research was reviewed as source material, with targeted primary-source checks; this is not a verification of every citation or a systematic clinical review. Clinical target lists and candidate pathways require independent confirmation before release. Proposal choices (module grouping, field names, service interfaces and sequencing) are Telesphoros design recommendations, not CPIC or laboratory requirements.

| Source | Use / limit |
| --- | --- |
| [CPIC guideline catalogue](https://www.clinpgx.org/cpic/guidelines) | Starting inventory; guidance on using available results does not establish who should be tested. |
| [CPIC data v1.61.0](https://github.com/cpicpgx/cpic-data/releases/tag/v1.61.0), [API documentation](https://github.com/cpicpgx/cpic-data/wiki) | Proposed upstream reconciliation baseline. Release existence and repository inspected; no complete pair/cell audit or promoted clinical snapshot produced. |
| [PharmCAT genes/drugs](https://pharmcat.clinpgx.org/Genes-Drugs/) | Cross-check catalogue; includes source-specific content and cannot establish CPIC completeness or clinical validation. |
| [DPYD interim notice, July 9 2026](https://blog.clinpgx.org/cpic-comment-on-pending-dpyd-guideline-update/) | Targeted primary-text check: variant-specific pending HapB3 change while database values await publication. Used to motivate explicit conflict governance; no dose adopted. Final replacement publication was not established in this review. |
| [Ondansetron/tropisetron correction, Oct 26 2026](https://blog.clinpgx.org/cpic-release-v1-61-0-fix-for-ondansetron-and-tropisetron-recommendations/) | Machine-source corrections require reconciliation against publications/notices. |
| [CPIC retirement schema](https://github.com/cpicpgx/cpic-data/blob/v1.61.0/src/main/resources/db/migration/V79__retired_pairs.sql), [data history](https://github.com/cpicpgx/cpic-data/blob/v1.61.0/data.tsv) | Retired pairs must remain historical, outside active coverage. |
| [Hydralazine guideline](https://pmc.ncbi.nlm.nih.gov/articles/PMC12641075/) | Targeted text check: oral resistant-hypertension scope; insufficient heart-failure guidance. |
| [Serotonin reuptake inhibitors](https://pmc.ncbi.nlm.nih.gov/articles/PMC10564324/), [beta-blockers](https://pmc.ncbi.nlm.nih.gov/articles/PMC11502236/), [methadone](https://pmc.ncbi.nlm.nih.gov/articles/PMC11587193/) | Research-supplied primary references for drug/phenotype-specific boundaries; each exact rule still needs cell review. |
| [Thiopurines](https://pmc.ncbi.nlm.nih.gov/articles/PMC12997511/), [warfarin](https://pmc.ncbi.nlm.nih.gov/articles/PMC5546947/) | Combined-gene and population/context prerequisites; not dose tables in this proposal. |
| [AMP CYP2D6](https://pmc.ncbi.nlm.nih.gov/articles/PMC8579245/), [AMP DPYD](https://pmc.ncbi.nlm.nih.gov/articles/PMC12813241/), [AMP guidelines](https://www.amp.org/clinical-practice/practice-guidelines/) | Procurement target/class questions; selected lab's actual assay requires its own validation. |
| [G6PD](https://pmc.ncbi.nlm.nih.gov/articles/PMC10281211/), [MT-RNR1](https://pmc.ncbi.nlm.nih.gov/articles/PMC8613315/), [malignant hyperthermia](https://pmc.ncbi.nlm.nih.gov/articles/PMC6513720/) | Negative-result, measured-activity and specialist limitations. |
| [VKORC1 assay caution](https://blog.clinpgx.org/caution-which-snv-is-your-vkorc1-assay-is-using/) | Direct target versus proxy distinction. |
| [HL7 Genomics Reporting PGx, STU3](https://www.hl7.org/fhir/uv/genomics-reporting/STU3/pharmacogenomics.html) | IG 3.0.0 on FHIR R4. Individual genomic report versus longitudinal profile; future profile validation needed. |
| [FDA CDS guidance](https://www.fda.gov/media/109618/download) | Targeted primary-text check: Jan 29 2026 guidance includes discussion of NGS variants/patterns. Regulatory classification is function-specific; report format is not an exemption. |
| [PREPARE trial](https://pubmed.ncbi.nlm.nih.gov/36739136/) | Targeted primary-text check: 12-gene DPWG-guided European study, 6,944 participants; reported 21.0% versus 27.7%, OR 0.70. Neither validates this panel nor supports a universal 30% absolute risk reduction. No clinical-utility claim added. |

## Outstanding evidence

An exhaustive CPIC pair/cell inventory, current labels (especially CFTR), exact route/population predicates, all assay target definitions, partner analytical validation, clinical expected cases and artifact-specific redistribution licenses remain to be confirmed. CPIC data, ClinPGx annotations, PharmVar definitions and drug labels should each have their own source/terms record; one license label cannot cover all feeds. Regulatory, laboratory, reimbursement and secondary-use reviews are separate workstreams. Historical plan statements remain dated evidence, not current legal conclusions.
