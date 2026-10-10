# Phase 3D2: standard synthetic report upload

Founder approved with “go” on 2026-10-10. PR #58 already merged; fresh main `37b20ef`, branch `feat/phase3d-product-upload`. Sequential work; no agents or mandatory graph.

Objective: replace the standard VCF/JSON simulation with existing-patient selection and authenticated registration → SHA-256/presigned PUT → server-verified completion. Select patients from bounded API pages; never create a patient as a side effect. Keep one UUID request key for unchanged patient/type/file metadata and checksum across failed attempts in this mounted form, including lost registration/completion replies. Allocate a new key for changed input or a new upload. Retry data and file bytes remain in component memory, cleared on reset/unmount/sign-out; reload recovery is not included.

| Task | Prerequisite | Owner/scope/deliverable | Acceptance / verification | Status |
| --- | --- | --- | --- | --- |
| U1 | Approved plan; PR #58 merged | Single agent: inspect callers/contracts; API red control | Standard stub cannot complete authenticated registration; settled patient/retry/storage contract | done |
| U2 | U1 | Frontend API helper, product-specific schema, patient selector/form | Bounded patients; reuse key; preserve errors/input; token never sent to storage; success only after verified completion | done |
| U3 | U2 | Component/transport/browser controls and test-only S3 fixture | Lost replies, checksum/identity/destination refusals, changed input, pagination/loading/auth, real browser→API→S3 path | done |
| U4 | U3 | Status/runbook/verification and separate draft PR | types/lint/build/chunks, frontend and backend tiers, exact-head CI and actual logs | in progress |

No changes to local experiment transport/forms, PDF workflow, clinical logic/holds, auth policy, database migrations, infrastructure Terraform, AWS/deploy/production data/spend or independent file recovery. Use shared schema constraints and existing design tokens/controls.

Storage origin configuration is an exact build-time allowlist: HTTPS in production; loopback HTTP only for a loopback synthetic rehearsal. Reject unexpected origins, URL credentials, redirects, expired targets and extra headers before sending bytes. Object-storage fetch uses `credentials: omit` and no API bearer. Errors shown to users never include raw service text, file contents, signed URLs or tokens. Configuration and live S3 CORS deployment remain operational gates.

Synthetic verification only. Browser checks need real HTTP S3 because the backend memory store returns memory:// test targets; use task-owned Moto, isolated bucket, explicit dummy credentials and no AWS. Any PostgreSQL verification uses helper-generated test databases on the owned disposable cluster. Blast radius: only generated test databases, in-memory Moto bucket and helper-owned test processes; fixtures regenerate, preserve logs, never touch shared/production services.

Feedback: focused change→observed check→diagnosis→repair. Reassess after three unsuccessful repairs/repeated identical failure without new evidence/no progress; classify implementation/environment/requirements/permissions. Stop after the separate PR for founder review.
