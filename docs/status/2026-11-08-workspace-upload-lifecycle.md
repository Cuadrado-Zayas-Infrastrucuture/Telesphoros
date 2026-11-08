# Workspace upload cancellation and conversation ownership
Date: 2026-11-08

Workspace Stop now reports cancellation only when the existing owned-upload API
confirms it. Pending cancellation, transport/refusal errors and an already stored
file keep their distinct recovery messages and the original attempt identity.
No server, database, clinical or authorization behavior changes.

New chat and workspace unmount retire the conversation's upload, abort its local
byte transfer and stop its progress timer. Late responses cannot advance the
retired operation or overwrite a newer recovery entry. Retirement does not claim
server cancellation or clear saved recovery. Nested patient and panel navigation
keep the owning conversation mounted and its upload running.

Eleven frontend regression cases cover uncertain and confirmed cancellation,
retained request/attempt identity, delayed registration responses and bodies,
New chat during transfer, and preserved upload progress during patient navigation.
They use the real frontend upload and recovery modules with controlled synthetic
HTTP responses. Existing server and real-service safety tests remain unchanged.

Local validation uses Node 22.22.0 and pnpm 10.28.0, based on main
`4b61fb306333e0178b5bccad284156a7f3cf6d42`. With only the new test file applied,
eight regressions failed for the expected behavior and three controls passed.
After applying the fix, all eleven passed; the focused upload/recovery/workspace
run passed all 152 tests. The test file received the repository's normal Prettier
formatting without changing its assertions.

| Check | Local result |
| --- | --- |
| Workspace typecheck, lint, build and frontend bundle guards | Passed |
| Workspace tests with PostgreSQL and S3 services available, memory API profile | 5,799 passed; 759 profile-dependent backend cases skipped |
| Infrastructure guards | 454 passed |
| CI configuration guards | 237 passed |
| Engineering workflow guards | 5 passed |
| PostgreSQL/S3 API profile | 4,334 passed; 2 profile-specific cases skipped |
| Selected mobile/desktop browser flows | 86 passed; 2 viewport-specific cases skipped |

The frontend regression cases control the HTTP boundary and use the existing
fake sign-in client; the conversation, upload orchestration and recovery store
are real. Service tests use the repository's disposable PostgreSQL 16 and Moto
harness. The browser selection covers `workspace-home`, `upload`,
`upload-navigation` and `dashboard-guide` at 375px and 1280px, including the
real sign-in and upload paths, permission controls, recovery, accessibility and
expanded-state layout.

The PostgreSQL/S3 profile skips the memory-only patient-merge refusal (covered by
the memory run) and the opt-in patient-decision browser workflow. Each browser
project skips the navigation control for the other viewport. The five private
reader-engine specs remain excluded and are not passes. The standalone
PostgreSQL/memory-object profile and unselected browser suites were not run.
Native SWC checks use the supported execution context with their cache-integrity
checks intact. These are local results, not hosted CI acceptance. At the validation
checkpoint, nothing had been pushed, merged or deployed.
