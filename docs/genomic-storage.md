# Genomic storage and PGx evidence

Documentation guidance, reviewed 2026-10-11. This applies the [genomic-storage report evaluation](verification/genomic-storage-report-evaluation.md), which retains the original local evidence links. It does not approve clinical use, a vendor, a retention change or a new implementation. [STATUS](STATUS.md) remains the source for release and deployment readiness.

## Storage appropriate to Telesphoros

Preserve source laboratory reports and corrected versions alongside computable results. A structured extraction must retain its source identity and review history; it does not replace the laboratory's authoritative report. ACMG supports structured EHR incorporation and linking updated reports to originals. [ACMG EHR statement](https://doi.org/10.1038/s41436-020-0841-2).

Build on the existing [version-pinned evidence and deterministic engines](architecture.md). The following are design recommendations to verify in a separately scoped implementation, not assertions that all these fields or workflows exist today:

| Layer | Information to preserve | Purpose |
| --- | --- | --- |
| Source evidence | Exact report bytes/version/hash, laboratory and report identity, specimen/test context when supplied, amendments | Trace an accepted result to the evidence actually reviewed |
| Structured PGx result | Reported alleles/diplotype, assay scope, ambiguity/no-calls, relevant copy-number and structural findings | Avoid treating incomplete testing as a normal result |
| Interpretation | Phenotype, allele-definition and translation versions, guideline version, reviewer and correction history | Reproduce an interpretation and compare later reinterpretations without overwriting history |
| EHR presentation | Patient and organization binding, source/result references, purpose and access restrictions | Display only the intended patient's permitted evidence |

Generic ACMG/AMP pathogenicity classification or VCF annotation does not replace PGx allele-function and drug-specific interpretation. CPIC describes diplotype translation and assay limitations, including CYP2D6 copy-number ambiguity. Pin reviewed clinical content and preserve unresolved states; these recommendations do not lift existing clinical gates. [CPIC guideline](https://pmc.ncbi.nlm.nih.gov/articles/PMC8249478/).

Whole-genome archives, cohort stores and rare-disease matching are deferred until a product requirement establishes the need. If primary reads are eventually retained, select formats using representative data and lossless round-trip controls. CRAM encodes more than reference differences, including quality and record information; savings vary. [CRAM 3.1](https://academic.oup.com/bioinformatics/article/38/6/1497/6499262). The cited SeqArray benchmark compares VCF 14.0 with SeqArray 2.6, about 5.4-fold smaller, not 1,000-fold. That is a benchmark, not a capacity guarantee. [Zheng et al.](https://academic.oup.com/bioinformatics/article/33/15/2251/3072873).

## Retention authorities and existing policy

HIPAA does not set a universal medical-record retention period. Its six-year compliance-document requirements must be distinguished from clinical-record retention. [HHS medical-record FAQ](https://www.hhs.gov/hipaa/for-professionals/faq/does-hipaa-require-covered-entities-to-keep-medical-records-for-any-period/index.html); [Security Rule documentation requirements](https://www.hhs.gov/hipaa/for-professionals/security/laws-regulations/index.html).

The existing report-version setting remains **2190 days by default, with its existing minimum validation unchanged**. This is the repository's product policy pending confirmation of applicable Puerto Rico/federal law, customer obligations, record categories and legal holds. It is not a conclusion that this value satisfies every applicable obligation. The application still has no record-deletion path. This documentation neither authorizes deletion nor changes a retention job, lifecycle rule, Object Lock, database trigger or permission. See [report evidence](ops/report-evidence.md#retention-and-deletion) and [records specification](design/records-and-corrections.md#10-retention-backup-and-restore).

| Authority | What may be stated | What remains to resolve |
| --- | --- | --- |
| CLIA, 42 CFR 493.1105 | Two-year minimum for specified laboratory records and reports, with category-specific exceptions including pathology reports | Which record categories and organizational responsibilities apply to a particular integration |
| ACMG professional recommendations | Rehder recommends considering five-year retention of VCF and final reports | Do not relabel “should consider” as a universal mandate or as a current CAP checklist requirement |
| Accreditation and jurisdiction | Applicable requirements may differ by laboratory, record type and jurisdiction | Obtain the exact current CAP/local provisions; the supplied New York 7/25/21-year figures are not adopted here |
| Product policy and customer contracts | Existing configured periods and protections remain in effect | Record the authority, responsible party, trigger date, period, hold and approved disposal process for each category before operational changes |

Sources: [CLIA regulation](https://www.ecfr.gov/current/title-42/chapter-IV/subchapter-G/part-493/subpart-J/section-493.1105), [Rehder 2021](https://www.nature.com/articles/s41436-021-01139-4), [Tayeh designated-record-set statement](https://www.gimjournal.org/article/S1098-3600%2822%2901026-7/fulltext).

## Privacy, cloud and secondary use

- The 2013 Omnibus Rule expressly included genetic information in **health information**; it did not add genetic information as a new Safe Harbor identifier. [Final rule, printed p. 5661](https://www.govinfo.gov/content/pkg/FR-2013-01-25/pdf/2013-01073.pdf).
- Removing names does not establish genomic de-identification. Safe Harbor has residual-identifiability conditions; Expert Determination requires a documented very-small-risk determination, not a guarantee of anonymity. Assess actual linkage risks rather than using a universal SNP-count threshold. [HHS de-identification guidance](https://www.hhs.gov/hipaa/for-professionals/special-topics/de-identification/index.html).
- Cloud providers maintaining ePHI on behalf of a covered entity/business associate generally need a BAA even without decryption keys. Overseas hosting is not automatically prohibited by HIPAA; location affects risk assessment and other obligations. A BAA and US hosting alone do not establish operational compliance. [HHS cloud guidance](https://www.hhs.gov/hipaa/for-professionals/special-topics/health-information-technology/cloud-computing/index.html).
- Require encryption as an engineering policy. Current HIPAA encryption specifications are **addressable**, which requires evaluation and appropriate implementation/documentation rather than treating them as optional. Do not cite the proposed stronger rule as enacted law. [Current §164.312](https://www.ecfr.gov/current/title-45/subtitle-A/subchapter-C/part-164/subpart-C/section-164.312); [HHS NPRM](https://www.hhs.gov/hipaa/for-professionals/security/hipaa-security-rule-nprm/index.html).
- Separate permitted treatment/payment/operations uses from research, resale or model training. A BAA, SMART token or fixture consent flag does not establish authority for every secondary use. [HHS Privacy Rule summary](https://www.hhs.gov/hipaa/for-professionals/privacy/laws-regulations/index.html).
- GINA protections depend on the actor, information and action; “only asymptomatic individuals” is too broad. Life, disability and long-term-care insurance exclusions remain important. [NHGRI](https://www.genome.gov/about-genomics/policy-issues/Genetic-Discrimination).
- Do not use the historical $1.5 million penalty figure as a current universal ceiling. Categories, dates and inflation adjustments matter. [HHS 2026 adjustment](https://www.govinfo.gov/content/pkg/FR-2026-01-28/html/2026-01688.htm).

## Interoperability and procurement

The 2023 Dolin paper describes 15 FHIR Genomics Operations; that historical count is not an EHR capability guarantee. Distinguish operations from reporting profiles, pin the intended published specification, and verify the target EHR's supported resources and operations. A successful SMART launch proves neither genomic interoperability nor clinical validity. The current [OpenEMR pilot](ops/openemr-smart-pilot.md) remains read-only and synthetic. [Dolin](https://pubmed.ncbi.nlm.nih.gov/36548217/); [HL7 Genomics Reporting IG](https://www.hl7.org/fhir/uv/genomics-reporting/).

ANNOVAR is not an unrestricted open-source option for this company: commercial users/service providers require a license. Check annotation-database licenses separately. [Vendor terms](https://www.openbioinformatics.org/annovar/annovar_download_form.php). Refresh any cloud shortlist against current product documentation, covered services and contracts; a 2017 vendor list is not procurement evidence. Former Google Life Sciences documentation now redirects to [Batch](https://cloud.google.com/batch).

The evaluation did not clear the specific Genomics England “4,500 / 85%” statistic or the quoted $22/year storage estimate for reuse. Omit them from product claims and budgets until the exact source context and current cost assumptions are verified. These unresolved claims do not justify new infrastructure or clinical release.
