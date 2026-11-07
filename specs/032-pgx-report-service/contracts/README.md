# Proposed report and assessment contracts

These are design field dictionaries, not implemented API schemas. Names and enums here do not extend the existing runtime contracts or native FHIR vocabularies. Required means required for this proposed contract; unavailable values carry a reason, never an invented default. All IDs are tenant-scoped opaque identifiers. Dates use ISO 8601; instants include an offset and are stored in UTC. A date-only source remains date-only with its precision recorded.

## Records and ownership

| Record | Owned by | Required content and relationships |
| --- | --- | --- |
| `AssayManifest` | Laboratory | Immutable ID/version; laboratory and assay identifiers; validated specimen types; methods; reference assembly/transcripts; nomenclature versions; exact target/variant-class coverage; limitations; no-call/reflex policy; validation-document references. A new version does not change previous reports. |
| `IssuedLabReport` | Laboratory | Internal ID; issuer report ID/revision; accession; patient/specimen identifiers in protected storage; manifest reference or explicit unavailable reason; collection, issued and received times with source/precision; lifecycle; prior revision link; released-by attribution; exact PDF/structured object references; findings and laboratory interpretation. |
| `ExtractedReport` | Telesphoros | Issued-report reference; source hash/version; capture and acceptance IDs; parser/version; extracted values and their locations; per-field uncertainty; review state and reviewer. It is a derived transcription, never a laboratory amendment. |
| `ReconciledProfile` | Telesphoros | Versioned projection of explicitly selected findings across reports; all source IDs; reconciliation policy/version; conflicts and their review resolutions. Neither newest timestamp nor a “normal” call automatically wins. |
| `ClinicalContextSnapshot` | Telesphoros/clinician | Patient ID; medication-record versions and verification date; exact drug, formulation/route, indication, dose/unit/frequency if relevant; age at decision; relevant organ function/activity measurements with time/unit/source; interacting medications with start/stop/unknown times; other rule-specific prerequisites, including explicit unknowns. |
| `Assessment` | Telesphoros | Immutable ID and predecessor; selected report revisions/finding IDs/profile version; context snapshot; rule and translation snapshot; software version; generated time; status and per-drug results; reasons and citations; release/reviewer attribution; synthetic/clinical-use flags. |
| Decision / follow-up | Clinician | Existing result/evaluation/patient bindings, vocabulary, amendment chain, clinical date and recorded time. Preserve intent, medication exposure and observed response as different facts. |

The laboratory PDF and signed-out structured package must identify the same report revision. For an outside PDF without a structured package, the issued document is authoritative and the extraction is derived. Preserve original values alongside normalized representations. An authenticated connection verifies the sender; a hash only verifies content consistency. Patient, accession and specimen reconciliation is a separate required check. Where signatures are supported, record signer, verification result, method and trust-policy version; unsigned outside PDFs remain reviewable with their provenance limitation recorded.

## Finding contract

| Field | Representation and invariant |
| --- | --- |
| `findingId`, `reportRevisionId`, `target` | Stable within the issued revision; HGNC gene identifier/symbol or explicit locus ID. rs12777823 is a locus, not a gene. |
| `coverage` | Ordered/tested/not-tested/outside-coverage are separate dimensions below; reference exact manifest targets. If manifest is unavailable, say `unknown`, not `tested`. |
| `reportedCall` | Original text plus optional typed diplotype, allele pair, HLA call, variant or measured activity. Preserve copy number, phase, ambiguity set and reference nomenclature as supplied. Do not force HLA, mitochondrial, CFTR or G6PD evidence into a star-allele pair. |
| `variants` | Optional. When supplied: assembly, reference sequence/version, HGVS/coordinates, ref/alt, zygosity, phase, copy number and quality/detection limits as relevant. Missing VCF is not a reason to invent variants or refuse every otherwise usable lab-reported call. |
| `laboratoryInterpretation` | Exact original phenotype/function/activity score plus laboratory's translation version or unavailable reason. A Telesphoros-derived value goes in the assessment, not here. |
| `evidence` | Exact source object ID/version/hash and location: structured JSON pointer or accepted text hash and half-open Unicode-scalar offsets. Page/bounding box, if available, is supplementary; it does not replace the accepted-text binding. |
| `limitations` | Structured reason codes plus original laboratory wording; uncertainty, missing targets, unresolved phase and negative-result scope. |

Do not infer `*1/*1` from absence of tested variants without a validated, versioned laboratory interpretation that supports it. Do not “repair” a call with AI. Existing duplicate-gene and adapter holds remain unchanged until a separately reviewed structured-import adapter can establish authoritative analytical rows versus repeated summary mentions.

## Independent state dimensions

| Dimension | Proposed values | Rule |
| --- | --- | --- |
| Report lifecycle | preliminary, final, amended, corrected, cancelled, entered-in-error | An amendment is a new immutable revision linked to its predecessor. Preliminary/cancelled/error reports cannot supply an active prescribing assessment. |
| Order scope | ordered, not-ordered, unknown | A panel order is not evidence every target was tested. |
| Analytical coverage | tested, not-tested, outside-coverage, unknown | Attach to each target/variant class. |
| Analytical result | resolved, no-call, ambiguous, not-applicable | Not-applicable only when no analytical result is expected (for example not tested). |
| Interpretation | interpretable, indeterminate, conflicting, unsupported-definition, not-assessed | A resolved call may still be unsupported by the selected definitions. |
| Clinical disposition | applicable, standard-prescribing, no-recommendation, missing-prerequisites, outside-scope, retired, held-conflict | Per drug/context/rule, not a global gene flag. |
| Assessment lifecycle | draft, released, superseded, retracted | Release here means a controlled record state; separate `clinicalUse` and `actionable` fields remain not-approved/false in synthetic work. |

These are proposed product concepts. Current engine outcomes remain `shown`, `no-published-recommendation`, `held`, `abstained`, `no-guideline`. An approved future mapping must preserve distinctions: both standard-prescribing and applicable could have a verified `shown` source cell, but a held-conflict can never display that cell's wording. No new enum may silently parse as an existing outcome.

## Assessment result and rule contract

Each result binds `resultId`, drug code/system/version plus source text, route/formulation, indication, population predicates, required findings, missing prerequisites, disposition, guideline pair level, recommendation strength, exact source wording and citation locator. Pair level and recommendation strength are different fields. A combined-gene rule selects one joint cell; it does not apply independent dose reductions in series.

Keep four versions distinct: interchange `schemaVersion`; assay/nomenclature/translation versions; promoted `knowledgeSnapshotId`; assessment software/build version. Record effective clinical time separately from received/generated/recorded time. Genotype-derived phenotype and context-adjusted interpretation (for example inhibitor exposure) remain separate, each with its evidence and rule version. Unknown medication timing cannot be replaced with “current.”

A knowledge snapshot includes immutable copies and hashes of source tables/API payloads, retrieval instants, upstream release/commit, guideline publications/supplements, notices, artifact-specific licensing records, reviewed diffs, independent expected cases and named approvals. A live API or a release tag alone is insufficient. Rule records carry scope predicates, source locators, activation/retirement state, conflict/exception records, reviewer and effective dates.

For an interim conflict, retain both sources and hold the affected rule by default. A time-bounded exception needs explicit clinical approval, exact affected variants/cells, rationale, independent expected cases, expiry/review date and rollback target. Do not change the baseline silently. A new snapshot, medication change or report revision produces a deduplicated impacted-patient task, keyed by patient, trigger, source revision and target snapshot. Completion must record the actual reassessment; enqueueing is not delivery or review.

## Proposed caller boundary

Illustrative interface, not an available endpoint:

```text
importLabPackage(principal, requestId, pinnedObjectReferences, expectedPatientId)
  -> stored import ID, revision ID or needs-review reasons
assessReport(principal, requestId, reviewedImportId, contextSnapshotId, promotedSnapshotId)
  -> immutable assessment ID or held reasons
```

The server derives tenant/actor authority, reads exact source versions and owns bounded validation, identity reconciliation, current-review checks and the atomic record/ledger write. The caller never supplies trusted tenant IDs, approval flags, generated phenotypes or a URL to fetch. Same request ID/content returns the existing result; changed content under that ID conflicts. Same issuer/report/revision with different bytes is quarantined for review, never overwritten. A foreign/unknown record remains 404. Membership, current source revision, acceptance and disputes are rechecked at commit after work outside the transaction. Failed commits store no clinical record or orphaned ledger event. Preserve the existing intake size/type/resource bounds; limits for a new structured package require explicit design and tests.

## Output design for easier extraction

Partner deliverable: one released structured JSON package and matching selectable-text PDF, with shared report revision, finding IDs and content manifest. If a lab cannot supply JSON, request a stable PDF template and qualify that format separately. Signatures cover a defined manifest/payload; avoid circular self-hashes.

| PDF block, in order | Content |
| --- | --- |
| 1. Report identity | Laboratory, accession, patient/specimen verification fields, report ID/revision/status, collection/issue dates, amended-report link. |
| 2. Result summary | Stable finding IDs, gene/locus, original call and interpretation, explicit no-call/limitations; one authoritative analytical table. |
| 3. Findings detail | One finding per clearly delimited block; typed values, original wording, manifest coverage and method references. |
| 4. Assay limitations | Tested targets, untested/unsupported classes, detection limits, reflex guidance and negative-result scope. |
| 5. Provenance | Assay/nomenclature versions, sign-out attribution, machine-readable package identifier and validation references. |

Use single-column reading order, selectable text, repeated table headers, unambiguous units and explicit missing values. Avoid genes continued across columns/pages without their finding ID. Summary references must point to authoritative rows. Do not place an assessment inside the lab report in a way that implies laboratory authorship.

The separately titled **Telesphoros assessment** shows assessment ID, source revisions, medication verification date, context, current-medication results, holds, actionable-next-step wording only where approved, citations, limitations and review attribution. Chat and PDF use the same stored structured result; AI may explain approved content but cannot select or alter a rule. A QR/link must use authenticated access, not embed patient/genotype data or a long-lived bearer URL.

FHIR target for future implementation: Genomics Reporting IG **3.0.0 (STU3), on FHIR R4**. An issued GenomicReport is an individual report, not a lifetime profile. Map findings to appropriate observations and source attribution; do not fabricate variant observations when only a laboratory interpretation exists. Keep a separate derived assessment and provenance. Profile validation, terminology binding and status mapping require their own implementation evidence; JSON acceptance is not FHIR conformance.
