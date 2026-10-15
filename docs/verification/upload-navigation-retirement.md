# Upload navigation retirement — 2026-10-15

## Implemented

Local branch `fix/upload-navigation-retirement`, based on main `301b0353130d6f45db8b0606a96cc50939f04bb8`. This is the independent fix for review finding F06-R01. It carries neither the reviewed F06 recovery-scope implementation nor F07 download CORS changes.

Leaving Upload could abort its byte transfer while its earlier registration request or response body remained pending. Returning to Upload retained the authenticated session. An old continuation could then overwrite a newer upload's saved recovery; late cancellation could also clear recovery.

Started progress now has a lifetime separate from authentication. Page cleanup retires that progress before aborting transfer. Request boundaries, body consumers and metadata writes refuse retired progress. A new page restores eligible metadata into fresh progress. Retirement does not clear saved recovery, end sign-in, cancel a server attempt or delete a report. Idle progress is left usable through StrictMode's initial cleanup replay because it has no pending callbacks.

## Tests

| Check | Result |
| --- | --- |
| Original main, real page/provider/router stale-registration reproduction | Failed at the expected old-vs-new recovery assertion before the fix |
| Final frontend suite | 299 tests and 24 brand rejection controls passed |
| Workspace production build | Passed, including frontend TypeScript and branding gates |
| Frontend lint, final typecheck, chunk/foundation/production exclusions | Passed |
| Auth and patient permission suites, in-memory API | 64 passed; one existing PostgreSQL-only concurrency case skipped |
| Chromium, desktop 1280 and mobile 375, auth/upload/navigation | 50 passed; includes six new navigation cases |
| Separate browser build with only page retirement removed | Both stale-registration cases failed by replacing the newer recovery record |
| Disposable frozen-F06 composition, frontend suite | 322 tests and 24 brand controls passed |
| Disposable composition, workspace build and frontend lint | Passed |
| Disposable composition, /me controller and Cognito auth controls | 20 passed |
| Disposable composition, desktop/mobile auth/upload/compatibility/navigation | 60 passed |
| Final formatted navigation control in composition | Both response and body cases passed |

The new route test holds either registration response or its JSON body across navigation and starts a newer upload under the same sign-in, including initial StrictMode cleanup replay. Focused controls also retire pending state, declaration, transfer and cancellation bodies, preserve progress and prohibit subsequent requests.

Native browser controls retain original metadata exactly across navigation and reload, reuse report/declaration keys on retry, complete the newer upload after rejecting the stale response, and retain recovery until cancellation is acknowledged. A pending response is observed without waiting for an intentionally unread body to finish. The weakened build fails the exact metadata comparison on both viewports, establishing that this test detects the regression.

The composition used main plus frozen F06 `cf10828e306bcce4ec1430525a5d4ed92d3e2b3c`'s apps/packages delta and this race fix in a disposable source directory. Overlapping guards preserve both F06's authenticated-session retirement and this page lifetime. F06's exact roles-only `/me`, separately authenticated recovery scope, older-backend 404 memory-only fallback, legacy/expired metadata removal and caller-change controls remained green. No F06 branch was edited or advanced.

## Risks and controls

Tests used synthetic data, a loopback fake identity provider, a fresh in-memory API and versioned Moto S3. Inherited AWS configuration was removed; explicit dummy credentials and null config paths were used. No live database, cloud, PHI, deployment or hosted CI result is claimed. Database/schema/ACL changes are outside this frontend-only fix.

The independent branch still has main's existing v1 recovery behavior; scoped one-hour F06 recovery remains local and separate. Previously cached frontend code is unchanged until a later approved delivery loads the corrected assets. This work does not change the `/me` contract, auth provider, roles, backend, shared contracts, recovery schema, CORS, launchers or infrastructure.

All 11 pre-existing protected worktrees retained their starting heads, status and tracked-file hashes at the final integrity check. Local branch refs were compared before delivery. The new branch is local only, with no remote upstream.

## Follow-ups

Read-only review this independent branch before approving any push or draft PR. Integrate it separately from F06; later reconciliation of F06 must preserve both page and auth-session guards and rerun the composition controls on the actual delivery commits. F07 remains frozen and needs its own delivery decision. Hosted acceptance and deployment remain pending.
