# Stored synthetic PGx preview

This opt-in mode connects the isolated OpenEMR viewer to the existing local Telesphoros API. It reads stored synthetic evaluations instead of the registration's static PGx fixture. It does not add a production API route or provide production identity/consent integration.

## Explicit bindings

Build the workspace with pinned Node 22.22.0. The synthetic backend must already have its PostgreSQL/S3 pipeline configured, a synthetic patient, an independently accepted capture and a stored evaluation. The existing [local review workflow](../../scripts/local-review/README.md) describes that setup. This connector does not upload, accept, evaluate or correct records.

Keep backend credentials in `packages/smart-pilot/openemr/.runtime/stored-reader.json`, with permissions **0600**. The standalone pilot refuses a less-private file. This ignored directory is excluded from the production Docker context. Never commit, print or paste a resolved token. The file shape below is illustrative; placeholders are not working credentials:

```json
{
  "mode": "stored-synthetic",
  "apiBaseUrl": "http://127.0.0.1:3010/api/v1",
  "issuer": "http://127.0.0.1:4010",
  "clientId": "e2e-client",
  "readers": [{
    "ehrIssuer": "http://127.0.0.1:8301/apis/default/fhir",
    "clinician": "Practitioner/EXACT-EHR-USER-ID",
    "subject": "EXACT-BACKEND-SUBJECT",
    "tenantId": "EXACT-BACKEND-TENANT",
    "token": "LOCAL-SYNTHETIC-API-ACCESS-TOKEN"
  }]
}
```

Add `stored` to the exact patient's existing ignored `registration.json` entry, preserving its EHR UUID, synthetic marker and consent/interpretability flags:

```json
"stored": {
  "patientId": "EXACT-STORED-PATIENT-UUID",
  "label": "SYN-EXACT-STORED-LABEL",
  "evaluationId": "EXACT-STORED-EVALUATION-UUID"
}
```

Restart the standalone pilot to load these bindings. A stored selection disables static-profile fallback even if credentials are absent, expired or invalid. `ehr:configure` recreates the static rehearsal registration; reapply explicit stored bindings afterward. No demographic, “latest result” or automatic clinician matching exists. Mapping a user to a credential is an explicit local setup decision, not delegated production authorization. The credential may have broader backend permissions; the connector's request path uses GET only. Do not use a production credential.

The API authenticates the supplied bearer on `/me` using its existing signature/issuer/access-token checks. Only after that successful response does the connector decode the same token to pin subject, tenant, issuer, client and expiry to the explicit configuration. It requires a clinician or reviewer role (an administrator alone reads no clinical data). Decoding alone is never accepted as authentication. The EHR bearer is never sent to the backend; backend credentials never enter the browser response.

## What is read and withheld

Each preview reads `/me`, the exact patient, evaluation, report and capture, then rereads patient/report/capture/evaluation. Shared DTO schemas are reused. The closing reads refuse changed records; the result expires no later than either the SMART session or backend token. No token refresh is added. The viewer now rechecks evidence under the [bounded freshness contract](correction-history-preview.md).

In addition to existing SMART identity, consent, interpretability and medication gates, the reader requires:

- Exact stored patient UUID and synthetic label; exact evaluation UUID and patient/report/capture agreement.
- `scope: synthetic-test-only/1`, `clinicalUse: not-approved`, `actionable: false`.
- Evaluated/current/active state, no hold or replacement, current accepted capture decision and zero active disputes.
- A verified uploaded lab PDF whose digest matches the capture; capture decision/text digest/Poppler identity agreement.
- Complete canonical gene states with a supplied phenotype. A phenotype-only state emits no invented genotype. Duplicate, unresolved or incomplete gene states are withheld.

Failed API, schema, identity, history-chain or source-integrity checks return the sanitized unavailable response, with no partial data. A verified selected evaluation that fails a content eligibility gate returns history only, with no profile/source or static substitute. A stored selection without reader configuration reports `pgx_unavailable`. API 401/403/404/503, redirect refusal, timeout and size bounds remain in force.

## Source identity and consistency limits

By default, the stored DocumentReference contains report ID and SHA-256 metadata from the API, plus the selected capture ID on DiagnosticReport. No PDF bytes or object-storage version is invented. The source identifier is report/digest based, and a `source-retrieval` extension marks retrieval unconnected. To enable verified PDF bytes and exact version identity, use the optional [source-PDF configuration](source-pdf-preview.md).

The common FHIR builder preserves the original single-gene static fixture identities and supports multiple stored genes with distinct Observation identities. No recommendation text, drug advice, storage key or presigned URL is exported. The existing synthetic FHIR tags, warnings and disabled clinical actionability remain.

These are multiple authorized reads, not a database transaction snapshot. A change after the closing read is not continuously pushed into an already displayed view. Refreshing evidence makes fresh reads; patient changes require a new SMART launch. The [correction-history and stale-view contract](correction-history-preview.md) adds bounded polling and explicit history; it does not provide push invalidation. Consent is still the explicit synthetic registration flag, not production consent storage.

## Verification

The normal pilot suite tests bindings, refusal/control pairs, closing-read changes, expiry and the HTTP route's no-fallback behavior. The new backend `test/db/stored-pgx-preview.pg-spec.ts` is automatically included in the existing database CI tiers. It builds and invokes the actual standalone reader against the real Nest API, signed fake-IDP tokens and restricted PostgreSQL roles; in the S3 tier its setup uses the S3 emulator too. Setup creates synthetic records through existing write routes; the preview phase is GET-only and asserts unchanged evaluation/ledger counts. Existing ephemeral-database helpers clean up only the test's fresh database.

See [plan](../design/plans/synthetic-stored-pgx.md) and [verification](../verification/synthetic-stored-pgx.md). No retention, production route, clinical gate or clinical knowledge changes are part of this slice.
