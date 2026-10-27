# L2 synthetic storage browser

The standard upload page supports validated PDF, VCF and JSON intake when the frontend is explicitly built with `VITE_LOCAL_STORAGE_INTAKE=true`. This mode requires a non-production build served at `127.0.0.1`. The API independently requires an owned `LOCAL_STORAGE_RUN_ID`, disposable loopback storage/database configuration, and disabled clinical processing. The browser flag grants no server permissions. An absent/false flag retains the existing VCF/JSON transport; an invalid flag fails configuration. Intake failures never fall back to direct storage uploads.

Keep `VITE_REPORT_STORAGE_ORIGINS` explicitly configured for the owned emulator origin. It authorizes attachment retrieval only in this mode. Upload bytes travel through the configured authenticated API. No storage write credentials are given to the browser.

The existing patient picker and synthetic confirmation remain mandatory. Files must be nonempty, match the selected extension, and fit the 10 MiB cap. Browser checks are advisory; L1 validates syntax before writing storage. Success means the server verified storage, not clinical validity or processing.

## Retry and cancellation

Registration request identity, the original declaration revision, and accepted attempt identity live only in the mounted form. Lost replies replay the same registration/declaration or resume the existing attempt; a stored report is checked before another transfer. Changing a pending upload requires cancellation first. Cancel aborts the active browser transfer and requests server cancellation; pending/unknown cancellation does not unlock “Start a new upload.” A committed upload cannot be cancelled retroactively.

Reloading, leaving the page, or signing out loses this in-memory retry state. Aborting a request does not certify server cancellation. Check Reports for verified files before starting another upload. Durable journal reconciliation remains L1 server behavior; the operational runner/scheduler and cleanup workflow are L3, outside this change.

## Reports and downloads

The `/reports` page is in every build since 2026-10-27; only file download is owned-mode only, because signed links need the storage origins this mode configures and the publish script refuses. It reuses tenant-bound pagination (20 rows) in the API's existing creation order. Clinicians can upload; clinicians and reviewers can download verified files. An administrator alone is refused the page (administration is not clinical access). Readers can see their tenant's metadata only. The server remains authoritative for all access decisions.

Downloads obtain a fresh signed attachment link, validate its contract, expiry and explicit allowed origin, and fetch with no cookies, API bearer, referrer or redirects. The client bounds the received bytes and verifies size/SHA-256 against the listed metadata before saving an opaque attachment. Temporary object URLs are revoked; no file is rendered and signed URLs are not persisted. A changed or unavailable file produces a safe retry message. Signed links remain bearer credentials until expiry; logout cannot revoke already issued links.

## Verification entry points

`pnpm --filter @telesphoros/frontend e2e:storage` builds and runs the L2 suite. It requires `E2E_DATABASE_URL` supplied privately for an already provisioned, migrated disposable loopback database using a non-owner application role. Set `CHROMIUM_PATH` and `MOTO_SERVER` where needed. The test config refuses a missing database, non-loopback host, non-disposable name or the postgres login. Verify the supplied application's actual role privileges separately; a username check is not an RLS proof.

The existing browser fixture owns a fresh in-memory Moto process and refuses occupied ports. L2 tests use one worker, a generated run/bucket identity, disabled processing, and synthetic inputs. The final version-pin test deliberately adds a newer version only after other tests: L1's complete-inventory invariant must continue to reject subsequent intake in such a run. The fixture stops only its own children. This is test harness configuration, not L3 product setup, scheduler, teardown, multipart rehearsal, or production readiness.

Run the existing `pnpm --filter @telesphoros/frontend e2e` separately to verify non-owned and experimental compatibility. Do not point either suite at clinical-review services, shared Moto, AWS, or real records.

## Memberships

Since M1.5 the API reads each person's standing from the database, so the PostgreSQL browser suite needs its personas granted once, after the
database is migrated and before `e2e:storage` (the in-memory browser suite needs nothing: there the development mirror grants whoever signs in).
Use the owner connection of the same disposable database (`E2E_OWNER_URL` below is the loopback superuser or table-owner URL, never the application role's):

```
CLI="node apps/backend/dist/db/cli.js"; export DATABASE_MIGRATOR_URL="$E2E_OWNER_URL"
# Since M2.1a a membership must name a registered organization:
$CLI tenant create --id alpha --name "Alpha synthetic clinic" --by browser-suite
$CLI tenant create --id beta  --name "Beta synthetic clinic"  --by browser-suite
grant() { $CLI membership grant --tenant "$1" --sub "$2" --roles "$3" --by browser-suite --reason "local acceptance persona"; }
grant alpha 11111111-1111-4111-8111-111111111111 clinician            # alice
grant beta  22222222-2222-4222-8222-222222222222 reader               # bob
grant alpha 33333333-3333-4333-8333-333333333333 admin                # carol: administration only, so she is refused the reports and the upload page
grant beta  44444444-4444-4444-8444-444444444444 ""                   # dave: signs in, holds no role
grant alpha 77777777-7777-4777-8777-777777777777 reviewer             # gina
grant alpha 88888888-8888-4888-8888-888888888888 clinician,reviewer   # hal
grant alpha 99999999-9999-4999-8999-999999999999 admin,reviewer       # ivy
```

erin (no tenant group) and frank (two) are refused before the membership is read and need no row. These are the fake identity provider's synthetic personas.
