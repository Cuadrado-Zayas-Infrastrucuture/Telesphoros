# Owned local synthetic storage API — L1

L1 accepts opaque PDF, VCF and JSON bytes with clinical processing disabled. It does not extract genomic values, run PDF content, invoke OCR/knowledge/evaluations or establish production readiness. L2 browser transport and L3 setup, sweep scheduling and automated teardown remain pending.

## Mode and compatibility

Set `LOCAL_STORAGE_RUN_ID` to the disposable run UUID. This requires non-production mode, `LAB_REPORT_PIPELINE=disabled`, loopback PostgreSQL with SSL disabled and a `test_` or `synthetic_storage_` database name, and loopback S3 with a versioned `synthetic-storage-<run UUID>` bucket. The S3 adapter uses explicit dummy credentials and one write attempt; it cannot fall through to an AWS profile. Memory adapters are test doubles; real acceptance uses the restricted PostgreSQL application role and Moto.

An owned run belongs to one synthetic tenant, with up to two concurrent intakes per process and 100 MiB of durable uncommitted reservations. Use a separate run/bucket for another tenant. Tenant roles, RLS and patient/report composite foreign keys remain enforced. This is not a production tenant provisioning scheme.

In this mode `/upload-url` and `/complete` refuse the legacy direct transport. Outside this explicit mode, pre-existing VCF/JSON browser transport remains available until L2; it makes no new structural-validation claim. Legacy PDF transport outside this mode retains its processing gate. The founder approved this compatibility boundary separately.

## API sequence

All paths below follow `/api/v1/reports`; API bearer credentials go only to the API origin.

1. Register metadata using the existing `POST /reports`, optionally with its registration replay UUID.
2. `GET /:id/upload-state` returns the current revision and aggregate run status: pending bytes/count, last affirmative reconciliation and cleanup-stalled flag. No object key or file content is returned.
3. `POST /:id/upload-attempts` with `{requestId, revision, contentType, sha256}` declares an immutable attempt. Response: `{attemptId, revision, state, expiresAt}`. The original declaration revision is stored separately from the new attempt revision. Retry the exact original request to recover its state; different input conflicts.
4. `PUT /:id/upload-attempts/:attemptId/bytes`, `X-Upload-Revision: <attempt revision>`, exact declared `Content-Type`, raw bytes, no compression/query. Chunked transfer is supported. Authorization and revision/lease checks precede consumption.
5. Success is `state=committed`, after complete structural/hash/size validation, one conditional S3 PUT, exact-version read-back, and an atomic PostgreSQL pin/journal transaction. Fetch the report DTO separately for `fileUploaded=true`.
6. A lost reply uses bodyless `POST /:id/upload-attempts/:attemptId/resume` with the same revision header. It reconciles the existing version; it does not send another PUT. Cancel with bodyless `POST /:id/upload-attempts/:attemptId/cancel` and that header. Cancellation cannot remove a committed pin.
7. `GET /:id/download-url` permits clinician/reviewer/admin, requires live owned metadata and a verified non-null pin, rechecks exact hash/size/MIME/version, and signs that same version with attachment disposition and private/no-store. Reader roles remain metadata-only. Issued URLs remain bearer credentials until their short configured expiry.

Clinician/admin alone may declare/intake/resume/cancel. Clinical endpoints keep their prior authorization-first 401/403 and processing-disabled 503 refusal.

## Intake bounds

- 10 MiB exact decoded length; no compression. Two admitted bodies, immediate refusal of a third; no waiting queue.
- 60-second absolute monotonic body deadline, 10-second inactivity/socket timeout, five-second startup allowance, then 256 KiB/s per five-second progress window. Staging backpressure has its own five-second stall budget. HTTP header timeout is 30 seconds; unrelated route body policies remain unchanged. Route timeout listeners are removed and the prior socket timeout restored.
- Private 0700 staging directory, exclusive 0600 file and fsynced ownership receipt. Hash and syntax validation stream into that file. Only complete valid files stream into S3; malformed/partial/rejected bodies cause zero storage writes. Exact owned files are disposed before freeing reservations. Interrupted staging requires a trusted owned receipt, matching filesystem identity and a dead writer; unexpected files/symlinks/live writers are retained.
- PDF: `%PDF-1.0`–`1.7` or `2.0` at byte zero, newline, final `%%EOF` followed only by whitespace. Nine-byte prefix and 1 KiB tail retained. These checks do not certify malware-free or clinically valid content.
- VCF: strict UTF-8, first-line versions 4.1–4.5, all eight fixed columns in order; additional columns require FORMAT and sample names. 256 KiB header, 64 KiB line limits, measured in bytes. Rows remain opaque. No gzip/BCF.
- JSON: strict UTF-8, no BOM/trailing syntax, maximum depth 64, string token 65,536 characters, number token 128 characters and finite numeric values. Incremental syntax only; no document string or object tree.
- Tests enforce a 96 MiB RSS-increase ceiling for two simultaneous 10 MiB bodies and a 256 KiB maximum concatenation; observations include the test client, API, SDK and read-back. These local measurements do not establish a production capacity or RTO.

## Journal, failures and compensation

Migration 0015 adds immutable tenant/report/patient/principal/request/revision/type/size/hash/key attempt identities, forced RLS, a run quota and a durable cleanup-stalled/last-reconciled status. Report material changes rotate the revision. Verified types cannot be reinterpreted; permitted filename correction remains possible. Start/validation renew the one-hour lease only for the matching live writer. Completion locks and compares the current row and attempt inside one parameterized tenant transaction, with no S3 I/O held inside it.

A confirmed failed pin cancels the uncommitted stored attempt. Lost S3 or database replies remain unresolved/stored until affirmative recovery; an exception is not evidence of rollback. Structural rejection/disconnect records cancellation and quiesces the writer. Quota is freed only for a committed pin or confirmed owned cleanup; affirmative empty version and multipart inventories plus disposed staging can release a no-write rejection immediately.

`LocalUploadCleanup` is a separate operations library, not an application provider or scheduler. Its caller supplies a trusted durable owned setup receipt, complete protected-evidence inventory and explicit multipart receipts. The library refuses non-local targets and missing ownership. It finishes version/multipart/reference/retention inspection before deletion, uses shared durable claims, deletes exact versions only, aborts owned multipart IDs only, and confirms both inventories are empty before releasing quota. Default grace is 86,400 seconds after expiry; safely cancelled attempts do not wait. `LOCAL_UPLOAD_CLEANUP_GRACE_SECONDS` accepts 0–604,800; shortened grace requires the owned local mode and cannot waive retention/references/inventory.

Sweep bounds: 100 candidates/actions, 30-second deadline, 1,000 pages and 10,000 inventory entries. Missing/repeated cursors, caps, timeouts or unavailable reads fail closed. Interrupted/delete-reply-loss claims are retryable. Failed reconciliation blocks new reservations until an affirmative sweep succeeds. Unknown row-less objects are retained and block admission, even with a matching-looking metadata tag. The FK prevents an application-created journal from losing its corresponding report; absence alone never authorizes deletion. Soft-deleted pins and protected catalogue/text references remain protected.

L3 must provide the manifest, trusted catalogue adapter, startup reconciliation and 15-minute scheduling. No operational schedule or automated stack teardown is claimed by L1. Moto proves local protocol behavior; it does not prove AWS policy, Object Lock custody, billing, signature-expiry enforcement or production identity.
