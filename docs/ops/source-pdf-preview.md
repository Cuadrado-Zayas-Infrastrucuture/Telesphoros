# Authorized synthetic source PDF preview

This is an optional extension of the [stored synthetic reader](stored-pgx-preview.md), on loopback only. No real patient data, production credentials, EHR writes or deployment. Retention and clinical gates are unchanged.

In the existing private, ignored `packages/smart-pilot/openemr/.runtime/stored-reader.json`, add:

```json
"sourcePdf": { "storageOrigin": "http://127.0.0.1:5555" }
```

Use the exact origin of your local versioned S3 emulator. Paths, queries, credentials, fragments and remote hosts are refused in this configuration. Keep file permissions `0600`; preserve explicit clinician/EHR/backend subject/tenant and patient/evaluation bindings. Restart the pilot after changes. Omitting `sourcePdf` keeps metadata-only mode. Once enabled, any PDF failure withholds the entire evidence response; there is no fallback.

After the existing identity/consent/context/evaluation/source checks, the reader calls `GET /reports/:id/download-url` with the separate backend token. The existing endpoint authorizes the tenant and file-opening role and signs the pinned report version. The reader accepts only its configured storage origin and one nonempty, non-null `versionId`, then issues a bounded GET without either SMART/backend bearer or cookies. It refuses redirects and non-200 responses, and requires:

- A still-valid link before and after retrieval and after closing reads.
- Exactly matching `x-amz-version-id`, `application/pdf` and an unencoded response.
- Declared size within the existing 10 MiB report limit, matching response bytes and `%PDF-` signature.
- Computed SHA-256 matching the uploaded report and accepted capture.

The reader repeats patient/report/capture/evaluation checks after downloading, retaining current acceptance, correction and dispute checks. Successful retrieval makes ten API GETs plus one storage GET. Nothing writes to the backend or EHR; test setup uses separate existing write paths solely to create synthetic fixtures.

The FHIR DocumentReference embeds verified base64 PDF bytes, exact version and SHA-256, with no signed URL, storage key or credentials. The viewer offers an explicit local download named `synthetic-source.pdf`; it does not render the PDF in an iframe or navigate to storage. Its blob URL is revoked on session expiry, chart change and unmount. A user-saved copy cannot be revoked; this is synthetic-only and does not establish a retention policy. No PDF sanitization, malware-safety or clinical-validity claim is made by a type/signature/digest check.

The preview expires at the earliest SMART, backend-token or signed-link expiry. Reads are not an atomic database snapshot or push correction feed. The [history/freshness contract](correction-history-preview.md) adds periodic revalidation and clears displayed bytes and blob links while checking or when stale. Version identity comes from the authorized pinned link and matching storage response, not a new public report DTO field. Core FHIR R4 validation does not establish Genomics Reporting IG conformance. Production consent/delegation and workflow acceptance remain separate.

See [verification](../verification/synthetic-source-pdf.md). Real PostgreSQL and Moto tests use signed fake-IDP credentials, restricted roles and newly created synthetic records. Moto does not prove live AWS IAM/retention enforcement.
