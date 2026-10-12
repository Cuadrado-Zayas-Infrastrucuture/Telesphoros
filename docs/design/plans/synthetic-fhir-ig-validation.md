# Synthetic terminology and FHIR IG validation

Approved scope: build from current main, read-only synthetic pilot only, then open one draft PR. No retention settings, clinical gates, authorization, production data or deployment changes.

Inspect the existing output against the published Genomics Reporting 3.0.0 R4 guide. Correct required genotype/report categories and report coding, preserve local phenotype semantics, define existing local extension shapes, and validate with the pinned official HL7 validator. Supplement with finite emitted-code checks and pinned published profile-pattern tests. Positive examples must pass and deliberately invalid examples must fail for their intended reasons. No complete clinical terminology or full-IG certification is claimed.

Keep patient/tenant-scoped business identifiers and source identities stable. Give changed representations a mapping revision in their snapshot IDs. Preserve every existing source-integrity, eligibility, freshness and read-only check. Verify pilot tests, real API regression, typecheck/lint/build, official-validator controls/defects and CI guards before opening a draft PR. Full synthetic workflow acceptance follows separately.
