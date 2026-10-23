# Phase 3D2 upload verification

Approved 2026-10-10, merged prerequisitePR #58, main `37b20ef`, isolated `feat/phase3d-product-upload`. Work is synthetic and sequential; no production/AWS/clinical change. Final delivery results will be recorded below; an unexecuted check is not acceptance.

## Observations and repairs

| Observed evidence | Root cause / repair |
| --- | --- |
| Standard stub never called the authenticated API; red transport control failed | Replace standard simulation with registration/PUT/server verification; leave the local experiment alone |
| Initial dependency install failed sandbox DNS | Frozen installation with registry access succeeded; package resolutions unchanged |
| One component assertion still expected patient-label text; one helper returned undefined after newline following return | Correct the oracle for the approved existing-patient field and return syntax; focused 67 controls passed |
| Lint rejected a CJS script under existing frontend conventions and ref-bearing handler passed at render time | Use existing MJS/Node convention and bind form submission inside the event handler; lint passed without disabling rules |
| First real browser run returned 429 after repeated uploads by the same fake persona | Isolate shared fixture quotas; retain production policy, add explicit 429 browser control and keep backend limiter suite |
| A retry control expected another object key | Actual service intentionally retains the key; require a second target request and the same object path, not a new key. File completion remains asserted |
| Non-backend tests failed to bind loopback inside sandbox | Repeat with loopback access; do not change assertions |
| Production entry chunk grew from 141 KB to 154 KB | Source maps show automatic chunk grouping folded the former shared UI utilities into the entry; total initial JS did not grow. Moving error classes did not help and was reverted. Explicitly split pure styling utilities; entry passes at 145.2 KB, unchanged 150 KB limit, all routes lazy |
| Retained PostgreSQL cluster startup tried occupied default 5432 | Start with explicit owned 54341 port; leave existing server untouched |

No third unsuccessful repair or repeated identical failure without new evidence was reached. Partial browser runs are diagnosis, not final acceptance.

## Controls and limitations

Transport controls cover UUID retention after lost registration and reselected identical bytes; fresh identity on changed patient/type/name/bytes; completion reply loss recovery withoutanother PUT; transfer refusal; mismatched patient/report/file/hash/content; destination/headers/expiry/method/privacy refusals; bounded/cancelled patient pages; validation before mutations and expired-session propagation. Component controls cover errors/focus/input retention, success/reset identity, loading, empty lists, paging/selection and retry after list refusal.

Real browser tests use actual fake-IdP authentication, API metadata and loopback S3 HTTP, check server-recomputed SHA-256 and existing-patient association, omitted object-transfer credentials, duplicate registration avoidance and refusal states on both mobile/desktop. Local experiments keep their original behavior and separate browser suite. PostgreSQL browser rehearsal and all backend tiers are recorded separately below.

Production-sized runtime, live S3 signature/CORS enforcement/IAM, auth/provider/hosting/BAA, cross-reload retry recovery, clinical processing/release and independent report-file recovery are outside this slice. A mounted form keeps memory state only; reload/unmount discards it, and abandoned partial metadata is not auto-deleted. Exact-head CI remains a delivery gate; final CI evidence can be recorded in the PRbody after publication without altering the reviewed code.

## Results

macOS / Node 22.22.0 / pnpm 10.28.0; pinned Moto 5.2.3 and PostgreSQL 16. All data synthetic. Helper-owned browser database was migrated through all 14 migrations and removed after the restricted-role rehearsal. Owned services stopped; fixture files/logs retained.

| Check | Actual result |
| --- | --- |
| Final frontend unit/component/transport/schema suite | 184 passed|
| Other unchanged workspace suites | 74 passed; fakeIdP needed loopback permission|
| Types/lint/build |Root checks passed; final frontend source checks passed after repairs|
| Production chunks/structure |Entry 145.2 KB gzip below unchanged 150 KB; seven lazy page chunks; 43 components checked|
| Four temporary defect injections |All four caused assertion failures; exact source restored; final positive suite passed|
| Production-built mobile/desktop browser suite | 54 passed|
| Separate local-development browser suite | 18 passed|
| Restricted-role PostgreSQL + S3 mobile/desktop upload rehearsal | 8 passed, fresh helper-owned schema/application login; database removed afterward|
| Complete backend tiers, with both service URLs set | 1,558 / 1,739 / 1,740 passed; 182 / 1 / 0 intentional profile skips; zero failures/missing-service notices. Durations45.126/45.803/49.505 seconds |
| CI configuration controls | 28 passed|
| Draft PR / final-head CI actual logs |Pending publication and inspection|

Mobile form and desktop success screenshots inspected: token styles/controls preserved; no horizontal overflow; completion clearly distinguishes stored file verification from clinical processing. Browser suite includes keyboard, accessibility and viewport controls. Raw local logs/screens/state retained under `<task workspace>`; source hashes in `outputs/phase3d2-state.json`. These results are not live/cloud or whole Phase 3 acceptance. Final-head CI and founder review remain delivery gates.
