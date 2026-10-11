# FHIR mapping boundary

The isolated [OpenEMR SMART pilot](ops/openemr-smart-pilot.md) now has a synthetic **FHIR R4 4.0.1** collection preview. It does not implement a production FHIR server, CDS Hooks service, clinical recommendation, or EHR writeback. The production API never imports this package.

## Stored synthetic evaluations

An [opt-in stored mode](ops/stored-pgx-preview.md) now feeds this same builder through existing authorized API GETs and shared DTOs. It uses explicit EHR issuer/clinician and stored patient/evaluation bindings, supports multiple canonical genes and phenotype-only states without inventing a genotype, and refuses changed/stale/held/disputed records. Its source DocumentReference is metadata-only: report ID and SHA-256, **no asserted storage version or fetched bytes**. `capture-id` links the selected capture identity on DiagnosticReport; `source-retrieval` discloses the unavailable retrieval integration on DocumentReference. Both extensions use the existing pilot namespace and `valueString`. Static embedded fixtures remain available only when stored mode is not selected.

The fixture-specific rules and embedded-source statements below describe static mode; stored mode's authorization, source and consistency limits are in its runbook. Neither mode is production approved.

## Mapping contract

`GET /auth/fhir/pilot/evidence` adds `pgxFhirPreview`, either a self-contained collection Bundle or `null`. It uses the existing authenticated SMART session, verified synthetic Patient, medication context and post-read expiry check. No new scope, endpoint, storage service or bearer credential is introduced.

| Supplied synthetic data | FHIR representation | Boundary |
| --- | --- | --- |
| Selected immutable evaluation | DiagnosticReport identifier and content-derived resource ID | Explicit selection; one current version; no “latest” fallback |
| Supplied diplotype | Observation, LOINC `84413-4`, text value with gene and diplotype | No inferred genotype or allele normalization |
| Supplied phenotype | Separate Observation with a documented pilot-local code | No clinical terminology equivalence or engine calculation claimed |
| Exact source report/version | DocumentReference masterIdentifier scoped to EHR, tenant and patient | Source identity is separate from evaluation identity |
| Verified source SHA-256 | Attachment `source-sha256` extension | R4 Attachment.hash is SHA-1, so SHA-256 is not placed there |
| Synthetic source bytes | Base64 text/plain Attachment with byte size | Only the two fixed synthetic documents are accepted; no PDF retrieval or object-storage integration |
| Engine version | Device.version, referenced by Provenance.agent | Synthetic fixture engine; not a clinical performer |
| Knowledge-set and acceptance identity | DiagnosticReport `knowledge-set-id` / `acceptance-id` extensions | Versions remain explicit, not a mutable knowledge lookup |
| Source-to-interpretation relationship | Observation.derivedFrom and Provenance.entity/target | All references resolve within this Bundle |
| Verified EHR patient ID | Patient.identifier scoped to its issuer | No name, demographics, inferred match or live EHR resource replacement |

Pilot extensions use `https://telesphoros.app/synthetic-smart-pilot/StructureDefinition/{name}` and one `valueString`: `source-report-id` and `source-version-id` on DocumentReference; `source-sha256` (lowercase, 64 hex characters) on Attachment; `knowledge-set-id` and `acceptance-id` on DiagnosticReport. These are documented local mapping fields, not published HL7 extensions or a registered IG. Genotype and phenotype Observations have distinct scoped business identifiers; neither uses the parent evaluation identifier as its own result identity. All required interpretation/source metadata remains in the bundle.

The preview is a `collection`, never a transaction, batch or FHIR document Bundle. `fullUrl` values are logical identities within the collection, **not implemented HTTP endpoints**. Content-derived IDs are stable for the same validated snapshot; changes to the interpretation change its IDs while an unchanged source keeps its identity. Business identifier systems also include an EHR/tenant/patient scope digest so separate fixture patients cannot share an identifier namespace. No `meta.versionId` or `_history` URL is invented: those belong to a FHIR server's resource revision lifecycle.

The current fixture models source v1 / evaluation 1 as superseded and source v2 / evaluation 2 as current. Only the explicitly selected, current, active evaluation can be previewed. Historical bytes are not emitted alongside it. This slice does not export correction history, replacements or retractions to an external FHIR server; a changed disposition supplied to the mapper withholds the preview. Runtime fixtures are loaded at process startup; this is not a live production correction feed. The sample tests can reconstruct the earlier snapshot as it existed when current.

`issued` and `recorded` use declared fixture timestamps, not a claim that mapping ran then. No specimen collection date or historical test encounter is invented from the SMART launch encounter. FHIR `final` means the supplied synthetic snapshot is complete; it is **not clinical approval**. Every resource is tagged `synthetic-not-for-clinical-use`, the report carries a fixed warning, and the envelope always has `clinicalRecommendationsEnabled: false`.

## Refusal rules

The preview is withheld without partial source disclosure when consent, interpretability or the existing complete medication/profile context gate fails; the selection is missing, stale, duplicated, held, retracted or superseded; another version is also current; acceptance is rejected or stale; a dispute is active; any version belongs to another patient/tenant; a required engine/knowledge/source version is absent; a digest mismatches; or one source version has conflicting content. Old registrations without versioned fixtures return `null`; malformed versioned registrations are rejected at startup. No prior result is substituted, and no recommendation is generated. The original fixture label remains a separate display-only field.

The fixture schema accepts only `clinicalUse: "not-approved"`, `actionable: false`, synthetic version labels, one explicit CYP2C19 diplotype/phenotype pair and two fixed source documents. This intentionally narrow adapter is not a production evaluation DTO adapter, clinical variant validator, or support for arbitrary labs/genes. No biological correctness claim follows from schema acceptance.

## Standards and validation limits

- [FHIR R4 DiagnosticReport](https://hl7.org/fhir/R4/diagnosticreport.html), [Observation](https://hl7.org/fhir/R4/observation.html), [DocumentReference](https://hl7.org/fhir/R4/documentreference.html), and [Provenance](https://hl7.org/fhir/R4/provenance.html) define the core resource relationships used here.
- [R4 Attachment.hash](https://hl7.org/fhir/R4/datatypes-definitions.html#Attachment.hash) defines SHA-1; source SHA-256 stays separately labelled.
- [Genomics Reporting IG 3.0.0 Genotype](https://hl7.org/fhir/uv/genomics-reporting/STU3/StructureDefinition-genotype.html) supplies the genotype display-code reference. IG 3.0.0 is based on R4; “STU3” in that URL is the IG's release label. No IG `meta.profile` conformance is asserted. The phenotype/report concepts deliberately use the pilot namespace until a separately reviewed terminology/profile mapping exists.
- Tests validate the collection against the [pinned official R4 JSON schema](../packages/smart-pilot/test/fhir-r4/README.md), with additional required-primitive, reference-closure, digest, identity and safety assertions. The schema is not a full FHIRPath or terminology validator; no validator.jar/IG validation or clinical certification is claimed.

## Next separately scoped work

A production adapter would require authorized tenant-bound repository reads, a reviewed correction/history contract, approved lab/phenotype terminology and IG validation, real version-pinned report retrieval with authorization, and clinical release approval. None is enabled by this preview. Retention policy and clinical gates remain unchanged.
