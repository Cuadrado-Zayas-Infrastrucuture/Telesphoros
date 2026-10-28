# Synthetic Genomics Reporting validation

Run `pnpm --filter @telesphoros/smart-pilot build` then `pnpm --filter @telesphoros/smart-pilot test:ig` with Java 21 (`JAVA_HOME`). CI runs this after the workspace build. The command accepts no patient files, report URLs or runtime registrations: all input is generated synthetic data. It never calls the EHR or backend and uses `-tx n/a` to disable remote terminology submission. Artifact/package downloads still require network access. `FHIR_ARTIFACT_DIR` chooses where the pinned JAR and IG are kept (default: the temp directory); CI caches that directory and `~/.fhir/packages`, keyed by this script, so a warm run skips about 140 s of downloads. Each run prints how long each validator call took, and a failed call prints the end of the validator's log. Missing Java, unavailable packages, checksum failures, missing outcomes and unexpected validation results fail the command; nothing is silently skipped.

## Pinned external oracles

- [HL7 FHIR Validator 7.0.1](https://github.com/hapifhir/org.hl7.fhir.core/releases/tag/7.0.1), JAR SHA-256 `1178b6a3a3fe98d9cd9545cadee505274967332466001d857e4d8bed7138a5bc`.
- [Genomics Reporting STU3, version 3.0.0](https://hl7.org/fhir/uv/genomics-reporting/STU3/), published FHIR R4 4.0.1 IG. [Package](https://hl7.org/fhir/uv/genomics-reporting/STU3/package.tgz) SHA-256 `7a42cdfae8d47f0d39a2ad5c46ec9028ede4848655600e7deaff440b44d4d221`.
- Unmodified gzip-compressed published snapshots under `published/`: genotype JSON SHA-256 `07b716b45acb5867bc1e58b0a1c51156befb47e19ccb74910ae6e863fc902f25`; genomic-report JSON SHA-256 `c7deb5b92af3eb72eeca9145f913adcdc7e83345a4052b4c449fc8d95979bcff`.

The official validator resolves the package's dependencies through its standard package cache. Its logs record loaded versions. This pins the primary validator/IG artifacts, not every validator-managed terminology dependency. The snapshots retain their published copyright/license notices, including the LOINC notice. See the [FHIR license](https://hl7.org/fhir/R4/license.html) and the IG's published legal notices.

The local StructureDefinitions describe the existing pilot string extensions with explicit contexts. Local CodeSystems describe only the synthetic phenotype code and safety tag. They are draft, experimental, offline test artifacts, not published registries or clinical standard codes.

## What is checked

Four positive Bundles cover embedded text, stored metadata, stored synthetic PDF attachment, multiple genes, phenotype-only states, and correction/source metadata. Four defects must be rejected individually: missing genotype categories, wrong report code, wrong genotype value type, and wrong local extension value type. Positive outcomes must contain no error/fatal issue; every negative outcome must contain at least one. Execution must succeed and outcome counts must match every input. The pinned CLI returns zero even for error outcomes, so parsed severities and the expected defect reason decide conformance, never exit status alone. Outcomes and logs remain in the printed local evidence directory (`FHIR_IG_OUTPUT` may choose it).

Normal pilot tests also check the published code/category patterns and a finite terminology surface: LOINC `84413-4` and `51969-4`; observation-category `laboratory`; v2-0074 `GE`; v3-DataOperation `CREATE`; and explicitly local phenotype/tag codes. Wrong code/system mutations fail. This is an exporter contract, not a general terminology service or validation of arbitrary LOINC/SNOMED/PharmVar/HGNC values. MIME types are independently fixed to text/plain or application/pdf by the existing source mapping.

## Limits and reviewed warnings

Only genotype Observations and DiagnosticReport declare Genomics Reporting profiles (`|3.0.0`). Local phenotype Observations remain unprofiled core R4; no therapeutic/diagnostic implication, coded metabolizer equivalence, star-allele normalization or recommendation is inferred. Genotype text is expressly permitted by the published profile. The report's open result slicing permits the local phenotype; genotype's open derivedFrom slicing permits the source DocumentReference. These produce informational unmatched-slice notices.

Narrative, Observation performer and effective time are absent because the input does not supply clinical facts for them; best-practice warnings remain visible. No collection time, clinical performer, specimen, or clinical approval is fabricated. Disabled remote terminology causes informational notices for values such as MIME types. No warning-suppression flag is passed. These runs establish no-error validation for the generated examples against selected published profiles plus the finite terminology contract; they are not a complete terminology certification, full IG implementation, clinical validation or production approval.
