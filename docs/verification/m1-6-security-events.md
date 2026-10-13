# M1.6 security-event audit store: verification

Implementation on local branch `claude/m1-6-security-events`, **stacked on the local M1.5 branch** (`claude/m1-5-live-membership`, itself merged with current `main`), because the membership trigger sits on the table M1.5 creates and the migration follows its 0016. Plan, decisions and what changed from it: [m1-6-security-events.md](../design/plans/m1-6-security-events.md). Results below were captured locally on 2026-10-13. **Nothing was pushed, so no remote CI has run and none of the required checks is claimed.** Synthetic data only; nothing applied in AWS; nothing tested against real Cognito or RDS.

## What was implemented

| Change | Where |
| --- | --- |
| Migration 0017: append-only `security_events` (refuse update, delete, truncate; allowlisted `details`), role `telesphoros_security_auditor`, `security_event_append()` (`SECURITY DEFINER`; organization and person from the transaction; only refusals and file links), trigger `tenant_memberships_audit` | `apps/backend/migrations/0017_security_events.{up,down}.sql` |
| Recorder (PostgreSQL and in-memory), wired as a global provider | `security-events/security-events.ts`, `storage/storage.module.ts` |
| Refusal events from the membership checks and from a write refused at commit; request id carried through | `auth/membership.service.ts`, `db/database.ts`, `auth/authority-context.ts` |
| File-link events recorded before the link, failing closed | `reports/reports.service.ts`, `lab-reports/captures.service.ts` |
| Auditor command `security-events list` | `security-events/security-events-cli.ts`, `db/cli.ts` |
| Role, classification and restore lists | `db/provision-logins.ts`, `db/privilege-facts.ts`, `db/append-only-tables.ts` |
| Docs | `docs/ops/security-events.md`, `docs/auth.md`, `docs/database.md`, `docs/ops/ledger-roles.md`, STATUS, plan |

No Terraform, frontend or dependency change.

## Tests added or changed

| Test | Proves |
| --- | --- |
| `test/security-events.e2e-spec.ts` (6, runs in memory, PostgreSQL and S3 tiers, without the token mirror) | A person with no membership, a removed person and a revoked token each leave one `access.refused` with the right reason; 25 refused requests from one person leave one event; an allowed request leaves none; a download link leaves a `file.link.issued` with report id and organization and no URL, token, file name or label; a reader gets no link and no event; with the recorder failing, the answer is 503, the object store is never asked for a link, and it recovers |
| `test/db/security-events.pg-spec.ts` (14) | Owner cannot update, delete or truncate; the application login has no privilege on the table (select, insert, update, delete, truncate all refused), the auditor can only read, another privileged role cannot; the function is executable by the application role only; it records the organization and person the transaction is bound to and refuses without them and refuses every membership event type and unknown types; details that could carry a secret (11 shapes: unknown key, URL, token, dotted name, space, over 64 characters, nested URL, extra key, wrong JSON shape, oversize) are refused while allowed shapes are accepted; the refusal throttle (one per person, organization and reason per minute, a different reason, person or organization is recorded, and a refusal older than a minute does not suppress a new one); the trigger records grant, role change, session revocation, removal and reinstatement in order with before and after roles and the operator name and **not** the free-text reason; a hand-written SQL change by the owner is recorded; a no-effect edit records nothing; when the event cannot be inserted the membership change rolls back; a write refused at commit leaves an `authority-changed` refusal with the request id; with the function not executable a real download link request answers 503 and creates no link, then works when restored; the auditor command lists newest first with only the stored fields, filters, and refuses bad input and the application login; a scan of everything the file recorded finds no token, URL, signed-link parameter, e-mail address or reason text |
| `test/lab-reports-capture.e2e-spec.ts` (+1), `test/db/ledger-catalog.pg-spec.ts` (+1) | Report and capture text links leave exactly their events and a refused link leaves none; the new table is classified, append-only, closed to the application and readable only by the auditor |
| Updated: migration lists in six specs, schema acceptance (keys, checks, indexes), recovery CLI migration count, privilege role lists, the M1.4 log spec and the report and capture service specs (new constructor argument) | Mechanical updates for 0017 |

## Defect injection

Each rule was broken on purpose, the named tests failed, and the file was restored (checked by grep).

| Injected defect | Result |
| --- | --- |
| Remove the membership trigger | 5 failed |
| Let the function use a fixed organization instead of the transaction's | 4 failed |
| Remove the append-only trigger | 1 failed |
| Make the link event best-effort (swallow the failure) | 1 failed (the 503 test) |
| Remove the details-string check from the table | 2 failed |
| Remove the throttle | 1 failed |
| Grant the application SELECT and INSERT on the table | 4 failed (privilege, catalog and auditor tests) |
| Do not record the token-revoked refusal | 1 failed |
| Let the application write membership event types | 1 failed |

## Full local regression

Node 22.22.0, pnpm 10.28.0, frozen lockfile. PostgreSQL 16 loopback dev cluster, Moto 5.2.3.

| Check | Result |
| --- | --- |
| `pnpm typecheck`, `pnpm lint` (after fixing two unused-variable errors it caught), `pnpm build`, `pnpm test:ci-config`, `pnpm test:infra` | passed |
| Tier 1 backend (no database or S3 variables) | 1,261 passed, 202 announced service-dependent skips, 0 failed |
| Tier 2 (PostgreSQL) | 1,944 passed, 20 skips, 0 failed |
| Tier 3 (PostgreSQL + Moto) | 1,964 passed, 0 skipped, 0 failed |
| Recovery rehearsal suites (3 files, 37 tests) | refuse to run as root; run as an unprivileged OS user from a copy of the repository: **37 passed** |
| Browser, in-memory API (`pnpm e2e`) | 56 + 18 passed |
| Built operator command, end to end | grant, set-roles and remove by the migration command produced three events in order; `security-events list` printed them with only the stored fields, filtered by type and limit, refused `--limit 0`, and the auditor login (a plain login in the role) could read |

## Limits

- **No off-site copy.** A person who can disable triggers as the table owner can still rewrite the record; the Object Lock copy that would close this is a later slice.
- Events mean "authorized and the link was created", not "the file was downloaded". `CapturesService.pdfLink` records the same event but no route calls it today and it has no test of its own.
- Not recorded by design: sign-ins and sign-outs, role-based 403s, clinical reads.
- Refusal events are best effort: a refusal made while the database is unreachable cannot be recorded (the request is refused with 503 either way).
- The PostgreSQL browser suite (`e2e:storage`) was not re-run for this slice; it does not exercise the new paths beyond file links, and that suite already has an unrelated failing test (see the M1.5 verification note).
- Nothing was run against real Cognito, RDS or a hosted environment, and no remote CI has run.
- Stacked base: M1.5 and M1.5b are unmerged local branches. Pushing M1.6 first would lack the membership table; M1.5 must go first.
