# FHIR R4 JSON schema

Gzip-compressed, otherwise unmodified `fhir.schema.json` from [HL7 FHIR 4.0.1](https://hl7.org/fhir/R4/fhir.schema.json.zip), retrieved 2026-10-11.

SHA-256 (JSON): `2230406893b4cf002a4ee1e5e2bbeca22ac5d2d4931b3e9ef7b9594bbc376a01`.

Tests use this independent structural oracle offline through pinned Ajv 6.15.0 (already used by repository tooling). The official schema does not validate FHIRPath invariants, terminology bindings, or Genomics Reporting IG profiles. The schema also omits required primitive cardinalities to allow extension-only values; the preview requires actual status/recorded/type values in an independent check. Reference closure, typed targets and safety gates have separate assertions. This is not a clinical conformance certificate.

FHIR specification is [CC0](https://hl7.org/fhir/R4/license.html). This repository uses the schema solely as a test fixture.
