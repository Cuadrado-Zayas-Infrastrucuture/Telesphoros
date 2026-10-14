# Standard synthetic report upload

Every report file reaches storage through the **validated server intake** ([design](../design/local-storage-intake.md), [M2.2 plan](../design/plans/m2-2-durable-intake.md)). The direct-upload routes (`POST /reports/:id/upload-url` and `/complete`) were removed in M2.2b and answer 404.

## How a file is uploaded

The signed-in clinician screen at `/reports/upload` uploads VCF or structured JSON (and lab PDFs where the pipeline is on). Select an existing synthetic patient from bounded pages of 20; it never creates patients. If none exist, someone with a clinician role must add one through the existing API.

The browser validates patient UUID, type/extension, filename, nonempty file and 10 MiB limit, computes SHA-256 and registers metadata with a UUID requestId (`POST /reports`). It then reads the report's upload revision (`GET /reports/:id/upload-state`), **declares an attempt** (`POST /reports/:id/upload-attempts` with the content type and SHA-256), and **sends the bytes to the API** (`PUT /reports/:id/upload-attempts/:attemptId/bytes`, raw, the declared content type, `X-Upload-Revision`). The server stages them privately, checks size, SHA-256 and bounded structure, and only then writes them to the reports bucket under `reports/<tenant hash>/<report id>/intake/<attempt id>`, pins the stored version and marks the report uploaded. The page shows success only when the attempt is `committed` and the report read back names the same patient, type, file name, size, SHA-256 and content type. A file the server refuses is never stored; the refusal is recorded as a security event ([security-events](security-events.md)).

The browser sends nothing to object storage when uploading. Quota: 100 MiB of uncommitted uploads per organization; two concurrent transfers per API process. A lab PDF is accepted only while the lab-report pipeline is on.

## Build configuration

`VITE_REPORT_STORAGE_ORIGINS` (a comma-separated list of exact origins, e.g. `https://synthetic-reports.s3.us-east-2.amazonaws.com`) is now needed **only for downloading** a stored file: the page fetches a signed link and refuses any origin not on the list, a URL with credentials or a fragment, or an expired link. Missing or invalid configuration fails before a download starts; uploads do not read it. Live bucket CORS must allow the approved frontend origin to `GET` (it no longer needs `PUT`); no cloud configuration is applied by this feature.

The API origin uses existing `VITE_API_BASE_URL`/OIDC settings.

## Retry boundaries

One mounted form keeps its original request key, report ID, declaration and attempt in memory. Unchanged input, including reselecting identical bytes with the same name, retains them. A lost registration response replays safely (same request key); a lost declaration or transfer reply replays the original declaration, which returns the durable state of the attempt, so a file the server already stored is never sent twice. A refused transfer keeps the form and the same attempt; Cancel asks the server to cancel it.

There is no background automatic retry. **Surviving a reload (M2.2c):** while an upload is in flight the tab keeps one small record in `sessionStorage` (`telesphoros.upload-recovery.v1`; this tab only, gone when the tab closes): the report id, the registration key, the original declaration, the last attempt state the server reported, and the file's type, name, size and SHA-256. It never holds the file's bytes, a token, a signed link or the patient. After a reload and sign-in the page says "An upload was interrupted" and names the file. Choose the same patient and the same file and press Upload report to finish it (no second report is registered; the original declaration is replayed; bytes are sent only if the server does not already hold them), or press Cancel the interrupted upload (the server must acknowledge before the page forgets it). A different file or patient is refused while an attempt is pending. The record is removed when the report is verified, when a cancel is acknowledged, and on sign-out; a session that merely ends keeps it. If the report no longer exists the page starts a new upload. Reset and navigation within the page still discard the file input.

## Abandoned attempts (operator)

An attempt that was cancelled, or whose lease ended and was never resumed, holds part of the organization's 100 MiB quota. `node dist/db/cli.js uploads sweep [--tenant ID] [--grace-seconds N] [--dry-run]` (run with `DATABASE_MIGRATOR_URL`) closes them: cancelled attempts at once, others once their lease ended more than N seconds ago (default 86400, at most 604800), never one a writer holds and never one a report or captured text points at. Start with `--dry-run`. **It deletes nothing from the bucket**: neither the application nor the operator login may, and a validated file that was stored but never committed is kept on purpose. The attempt stays on record as `cleaned`, its key stays known (so it does not block the report's next declaration), and the output says how many of the closed attempts may have left an object. Removing such an object is a break-glass act ([break-glass](break-glass.md)).

If a stray object appears under a report's `intake/` prefix that no attempt of the report accounts for (for example, one written by hand), that report's declarations answer 503 until an operator resolves it; other reports are unaffected.

## Verification commands

`pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm --filter @telesphoros/frontend check:chunks`, `pnpm -r --filter '!@telesphoros/backend' --if-present test`, `pnpm test:ci-config` and the three complete backend tiers in[STATUS](../STATUS.md#running-things-locally).

`pip install -r .github/ci/requirements.txt` installs the pinned test-only Moto. `pnpm --filter @telesphoros/frontend e2e` builds the actual product and runs mobile 375/desktop 1280 plus the separate development-route browser suite. Its owned loopback S3 fixture on 5557 refuses an occupied port, creates a fresh synthetic bucket/versioning/CORS and tears down its own process. API/fakeIdP/frontend use 3010/4010/4173. API credentials are explicit synthetic dummy values; the fixture never contacts AWS. Browser fixture quotas are disabled because all tests share fake personas; an explicit injected429UIcontrol and unchanged backend limiter tests cover refusals. This does not change production rate policy.

On macOS set `CHROMIUM_PATH` to an installed Playwright browser and put the Moto virtual environment on PATH. Optional `E2E_DATABASE_URL` runs browser API metadata through an already-migrated disposable PostgreSQL application login; never use a shared/production URL. The recorded rehearsal uses existing ephemeral database helpers and a non-owner/non-superuser/RLS-bound login; its owner alone creates/drops the synthetic fixture. Services/keys/BAA/hosting/production-size constraints, independent file recovery and clinical acceptance remain unverified by browser tests.
