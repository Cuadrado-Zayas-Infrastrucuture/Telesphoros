# M2.2c browser reload recovery: verification

Implementation on local branch `claude/m2-2c-reload-recovery`, **stacked on M2.2b** (`claude/m2-2b-retire-legacy-upload`), then M2.2a, the M2.2 plan, M2.1c-2 and the earlier M2.1 branches; none is a pull request yet (kept local at the founder's request). Plan and decisions DI-1 to DI-7 (yes to all, 2026-10-14): [m2-2-durable-intake.md](../design/plans/m2-2-durable-intake.md), which records where the build differs. Results below were captured locally on 2026-10-14. **Not pushed, no pull request, so no remote CI has run and none of the required checks is claimed.** Synthetic data only; nothing applied in AWS. **Frontend only: the backend, migrations and Terraform are unchanged, so the backend tiers were not re-run.**

## What was implemented

| Change | Where |
| --- | --- |
| The recovery record: one strict, validated `sessionStorage` entry, every read and write guarded; damaged or extended records are removed | `src/lib/uploadRecovery.ts` |
| Shared upload types (attempt, declaration, file facts) moved out of the transport so the record can use them | `src/lib/uploadProgress.ts` |
| The transport saves after registration, after the declaration and after each attempt state; restores a progress object; carries on with the same report when the same file is chosen; refuses a different file or another patient while an attempt is pending; starts afresh when the report is gone (404); clears on verification and on an acknowledged cancel; `SubmitError` carries the HTTP status | `src/lib/ownedStorageApi.ts`, `api.ts` |
| The upload page offers to finish or cancel an interrupted upload; Cancel and Start over no longer depend on the build flag (a leftover of M2.2b) | `src/pages/UploadReportPage.tsx` |
| Sign-out clears the record (a session that merely ends does not) | `src/auth/AuthProvider.tsx` |
| The local review experiment does not write the record | `src/lib/localReportApi.ts` |
| Docs | the plan, `ops/report-upload.md`, STATUS |

## Tests added or changed

| Test | Proves |
| --- | --- |
| `src/lib/uploadRecovery.test.ts` (16) | The record holds exactly the report, key, declaration, attempt and file facts and **not** the patient, a token, a link or any bytes (the raw text is searched); nothing is kept before the report exists; damaged or extended records are refused and removed; storage that throws is tolerated; the record is cleared on success and never written by the local experiment. After a reload: the same upload finishes with no second registration and the original declaration replayed; bytes are not sent again when the server already holds them; a stored attempt is resumed; another patient and another file are refused with the record kept; a different file starts afresh when nothing was declared; a gone report (404) starts a new upload and other refusals keep the record. Cancel: forgotten only when the server acknowledges (still there after a pending answer, a network failure and a 500); nothing to cancel when nothing was declared |
| `src/pages/UploadReportPage.test.tsx` (+4) | The banner names the file and size and is absent when there is nothing; cancelling goes through the server and removes the banner only on success; the restored progress is handed to the submit; no accessibility violations with the banner |
| `src/auth/AuthProvider.test.tsx` (+2) | Sign-out clears the record; a 401 that ends the session keeps it |
| `e2e/upload.spec.ts` (+5, desktop and mobile) | A real reload while the transfer is in flight: one report, one stored file, the same declaration replayed, and the record holds no patient id, token or link; a reload after the server stored the file sends nothing again; a different file is refused while the attempt is pending; cancelling after a reload leaves nothing stored, clears the record and the next upload works; signing out clears the record |
| `storage-e2e/storage.spec.ts` (+1) | The same reload against the real PostgreSQL and bucket: nothing in the bucket before the reload, exactly one stored version after |

## Defect injection

Each rule was broken on purpose with a script that edits the source, runs the frontend unit tests and restores the file.

| Injected defect | Result |
| --- | --- |
| Nothing is kept after registration | 2 failed |
| The record carries the patient | 11 failed |
| The record is kept after a verified upload | 4 failed |
| Sign out keeps the record | 1 failed |
| A different file is accepted while an attempt is pending | 1 failed |
| Another patient may take over the interrupted report | 1 failed |
| A gone report is not replaced | 1 failed |
| Cancel forgets before the server acknowledges | survived at first, then 1 failed after adding the "cancellation never reached the server" test |
| A restored upload loses its declaration | 4 failed |
| The page does not restore the interrupted upload | 2 failed |
| The same file after a reload starts a new upload | 5 failed |
| A damaged record is trusted | 1 failed |

## Local results

| Check | Result |
| --- | --- |
| Typecheck, lint, build (whole workspace) | pass |
| `test:ci-config`, `test:infra` | 35 of 35, 32 of 32 |
| Frontend unit | 23 files, 277 tests passed |
| Browser, in memory (desktop and mobile) | 68 and 26 passed |
| Browser, PostgreSQL storage mode (`e2e:storage`), on a database migrated to 0022 with the runbook's tenants and personas | 28 passed, 1 failed: `version-pin.spec.ts` (stale selectors in the spec itself; fixed in [#115](https://github.com/Cuadrado-Zayas-Infrastrucuture/Telesphoros-Remastered/pull/115)) |
| The new browser spec repeated three times | 18 of 18 each time |

Not re-run (untouched by this slice): backend tiers, recovery suites, shared types, smart-pilot.

## What this does not show

- No remote CI has run. Nothing was pushed, and there is no pull request.
- Recovery is per tab: closing the tab, opening the page in another tab or another browser, or clearing site data loses the record. Uploading the same file afterwards registers a new report; the earlier report stays as a record with no file, and its pending attempt holds quota until the operator sweep closes it.
- A person who ignores the banner and signs in as someone else without signing out keeps a record that only produces a banner; resuming it answers 404 and starts a new upload.
- The file name is stored in the tab's session storage (it is already stored on the report by the server). The patient is not.
- Real browser behavior on slow or flaky networks, very large files near the 10 MiB limit, and hosted sign-in (the fake identity provider stands in) are not measured.
- Nothing runs against AWS.
- `docs/STATUS.md` on `main` is stale in places beyond this slice.
