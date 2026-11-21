# The synthetic assessment can read signed knowledge, and a phenotype-only map takes the laboratory's phenotype (spec 044, slice K2a)

Date: 2026-11-21

Two founder-approved plans join spec 044: slice K (the first signed CPIC content, simvastatin and SLCO1B1 first; clopidogrel waits for an
indication design) and slice K2 (real guidance for synthetic patients on synthetic staging). This change is K2a, backend only.

A new setting, `ASSESSMENT_KNOWLEDGE`, chooses what the synthetic assessment reads: `synthetic` (the default, as before) or `signed`, which
reads `SIGNED_KNOWLEDGE_DIR` instead, always under the production rules (reviewed, not synthetic, two valid signatures from
`KNOWLEDGE_SIGNER_KEYS`), one set at a time. Configuration refuses `signed` without its directory or the signer keys, and either setting
while the assessment is off. An evaluation made against the signed set is stored with its own scope, `synthetic-patient-signed-knowledge`.

`planStructuredAssessment` keeps reading a gene from its resolved diplotype, except where the loaded map for that gene is phenotype-only (no
alleles, no method): then the laboratory's phenotype is the input, only if it is exactly one of the map's terms, and the binding records which
finding and translation it came from (`labPhenotypes`). Anything else holds the revision as `unsupported-source`. Today's synthetic maps all
carry alleles, so nothing about the synthetic assessment changes. Nothing changes in Terraform, the image or the frontend (slices K2c and K2d),
and no real content is added. The code was written without running it here (founder decision P2); CI is its first run. Validation note:
`docs/clinical-validation/assessment-signed-knowledge.md`.
