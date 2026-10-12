# Standard synthetic report upload

Owned local synthetic runs use the [L1 validated intake contract](../design/local-storage-intake.md). Their direct-upload routes are refused. The browser flow below describes the existing compatibility transport outside that mode; replacing it is pending L2.


The signed-in clinician/admin screen at `/reports/upload` uploads VCF or structured JSON through the existing report endpoints. Select an existing synthetic patient from bounded pages of 20; it never creates patients. If none exist, an administrator must add one through the existing API. PDF capture, clinical processing/review and release remain separate.

The browser validates patient UUID, type/extension, filename, nonempty file and 10 MiB limit, computes SHA-256, registers metadata with a UUID requestId, requests a presigned PUT target, sends bytes directly and requests completion. It shows success only when the returned report identity, size, content type and checksum match and the server marks the file verified. A completed report recovered after a lost response is checked the same way.

## Build configuration

Set `VITE_REPORT_STORAGE_ORIGINS` to an explicit comma-separated list of object-storage origins, e.g. `https://synthetic-reports.s3.us-east-2.amazonaws.com`. Use the exact origin returned by the approved bucket configuration, without paths, trailing slash, credentials, query or fragment. There is no inferred origin or wildcard fallback. Production-mode builds accept HTTPS only. Loopback HTTP is allowed only outside production mode when the frontend is also on 127.0.0.1, for synthetic rehearsals.

Missing/invalid configuration fails before registration; an unexpected URL/credentials/fragment, expired target or unexpected headers fails before bytes are sent. Only the declared Content-Type header is accepted. Object-storage fetch omits cookies and credentials, sends no API bearer, rejects redirects and omits the referrer. Raw service/transport messages, URLs, hashes and file contents are not displayed or logged.

The API origin uses existing `VITE_API_BASE_URL`/OIDC settings. Live bucket CORS must allow the approved frontend origin and PUT/Content-Type; no cloud configuration is applied by this feature. The backend's memory object store returns memory:// targets for test helpers and cannot support browser PUT. A configured HTTP S3 service is required for actual upload; the client refuses a memory:// target.

## Retry boundaries

One mounted form keeps its original request key, report ID and input/checksum identity in memory. Unchanged input, including reselecting identical bytes with the same name, retains the key. Lost registration responses safely replay the merged server contract. After a lost completion response, GET confirms the same uploaded report without another PUT. Failed transfer requests another presigned target for the same server-owned object key. Changed patient/type/name/size/bytes or “Upload another report” creates a new identity. Partially registered abandoned reports are retained; the UI does not delete them.

There is no background automatic retry or browser-storage persistence. Reset, navigation, reload and sign-out discard mounted retry state and file input. Reopening/reselecting after a reload can register a new report; cross-reload recovery needs its own design. Conflicts/deletion refusals preserve the form for inspection. HTTP 429 errors ask the user to wait and retry. Success means stored file verification, not clinical ingestion or acceptance.

## Verification commands

`pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm --filter @telesphoros/frontend check:chunks`, `pnpm -r --filter '!@telesphoros/backend' --if-present test`, `pnpm test:ci-config` and the three complete backend tiers in[STATUS](../STATUS.md#running-things-locally).

`pip install -r .github/ci/requirements.txt` installs the pinned test-only Moto. `pnpm --filter @telesphoros/frontend e2e` builds the actual product and runs mobile 375/desktop 1280 plus the separate development-route browser suite. Its owned loopback S3 fixture on 5557 refuses an occupied port, creates a fresh synthetic bucket/versioning/CORS and tears down its own process. API/fakeIdP/frontend use 3010/4010/4173. API credentials are explicit synthetic dummy values; the fixture never contacts AWS. Browser fixture quotas are disabled because all tests share fake personas; an explicit injected429UIcontrol and unchanged backend limiter tests cover refusals. This does not change production rate policy.

On macOS set `CHROMIUM_PATH` to an installed Playwright browser and put the Moto virtual environment on PATH. Optional `E2E_DATABASE_URL` runs browser API metadata through an already-migrated disposable PostgreSQL application login; never use a shared/production URL. The recorded rehearsal uses existing ephemeral database helpers and a non-owner/non-superuser/RLS-bound login; its owner alone creates/drops the synthetic fixture. Services/keys/BAA/hosting/production-size constraints, independent file recovery and clinical acceptance remain unverified by browser tests.
