# Synthetic PGx contract prototype (spec 032, slice S1)

Date: 2026-11-02
Status: Implementation authorized by the founder's “continue” after the [specification PR #259](https://github.com/Cuadrado-Zayas-Infrastrucuture/Telesphoros/pull/259). That PR remains open; this independently reviewable slice branches from main and does not require its files at runtime.

## Scope and contract

Implement strict, versioned, **synthetic-only** schemas in `packages/shared-types`, a bounded JSON parser, and invented report/assessment example packages under `data/fixtures/pgx-contracts`. A test-only script renders separate laboratory-report and Telesphoros-assessment PDFs with selectable text, repeated synthetic labels, explicit limitations and deterministic output hashes. No new dependency, production reader, API, database, UI, knowledge content or clinical activation.

The laboratory record preserves identity, dates, revision lineage, assay manifest (or reason unavailable), typed reported calls, laboratory interpretation and limitations. The assessment names the exact report revision, patient, context/medication versions and synthetic rule snapshot. Results preserve separate applicable, standard-prescribing, no-recommendation, missing-prerequisite, outside-scope, retired and conflicting outcomes. Neither a schema pass nor a file hash establishes issuer identity, patient reconciliation, clinical validity or authorization.

Limits: 256 KiB UTF-8 input before JSON parsing; bounded IDs/text/collections; 50 findings, 100 manifest targets, 50 results/medications. Draft version rejects unknown fields/versions and does not normalize original call text. Typed calls support diplotype, allele, variant, measured activity and explicit unresolved candidates; no missing-value defaults. Negative or unresolved findings stay explicit. Current runtime `GeneInput` and `DrugResult` enums are unchanged; this slice does not map draft results into the clinical engine.

Cross-record validation rejects mismatched report/patient/manifest/finding references, duplicate IDs, invalid revision lineage, contradictory coverage/result states and recommendation wording on held/unsupported results. An applicable/standard-prescribing result requires referenced resolved/interpretable/tested findings and a source cell in the synthetic snapshot; missing or conflicting facts cannot become an applicable result. Rules and context are supplied synthetic records, never inferred by this schema.

## Implementation sequence and evidence

1. Add independently authored resolved, uncertain and amended fixture JSON and public-schema refusal/success tests. Run against the absent implementation and retain the failure.
2. Implement schemas/parser and semantic guards. Verify preserved original values, typed states, identities, references, chronology, amendments, uncertainty and input bounds. Exercise targeted guard removal to prove refusal tests fail.
3. Render separate PDFs and an external artifact manifest (hashes of JSON and both PDFs; no circular self-hash), with source IDs on every page. Refuse unrenderable non-ASCII in this bounded prototype rather than corrupting text. All JSON fields appear in ordered sections, so no source limitation is silently omitted. Output bounds reject rather than truncate.
4. Verify deterministic bytes, fixture/schema compatibility, rendered required values, page bounds, PDF escaping and tampered artifact detection. Extract actual PDF text with available Poppler and visually inspect a rendered page. This is not qualification of an external vendor reader or pinned clinical extractor.
5. Run required workspace typecheck/lint/test/build, infrastructure and CI-config checks. Record skips explicitly. No database/S3/browser change, so those separate opt-in acceptance tiers are not claimed.

## Compatibility and deferred work

Names are prefixed `syntheticPgx` and schemas require literal synthetic/not-approved/non-actionable flags. Fixtures use invented genes/drugs and identifiers; they are not derived from the supplied personal reports. Existing runtime routes cannot accept these packages. Exporting the contracts permits future callers to share them but adds no trusted ingestion path.

Authentication, tenant scope, independent capture acceptance, source file version/hash checks, ledger commits, reconciliation across stored revisions and conflict expiry require S2/S3 service work. Real CPIC source cells, combined-gene prescribing, phenoconversion, FHIR mapping and laboratory analytical validation remain outside S1. Partial structural validation cannot certify those behaviors. Initial clinical module, partner assay and release approval remain founder/clinical-lead decisions.
