# M1.6 security-event audit store: verification

Implementation on branch `claude/m1-6-membership-trail`, built on current `main` (after #95 live membership and #96 no-role reads). It was first written on a stack of local branches and then moved onto `main` by cherry-picking; the migration became **0018** because `main` took 0016 (the application access audit, #94) and 0017 (membership) in the meantime. Plan, decisions and what changed from it: [m1-6-security-events.md](../design/plans/m1-6-security-events.md). Results were captured locally on 2026-10-14. **No remote CI had run when this note was written; the pull request's own checks are the record.** Synthetic data only; nothing applied in AWS; nothing tested against real Cognito or RDS.

**Overlap with #94, decided 2026-10-14: keep both tables, record each act once.** The application access audit on `main` already records every file link (a report download as `download-link`, a capture text link as a `private-read` of `CapturesController.textUrl`), so this store does not record links. The first version of this slice did (`file.link.issued`); it was removed after the founder's decision, in place, because the migration was still unmerged. See change 5 in the plan.

## What was implemented

| Change | Where |
| --- | --- |
| Migration 0018: append-only `security_events` (refuse update, delete, truncate; allowlisted `details`), role `telesphoros_security_auditor`, `security_event_append()` (`SECURITY DEFINER`; organization and person from the transaction; only refusals), trigger `tenant_memberships_audit` | `apps/backend/migrations/0018_security_events.{up,down}.sql` |
| Recorder (PostgreSQL and in-memory), wired as a global provider | `security-events/security-events.ts`, `storage/storage.module.ts` |
| Refusal events from the membership checks and from a write refused at commit; request id carried through | `auth/membership.service.ts`, `db/database.ts`, `auth/authority-context.ts` |
| Auditor command `security-events list` | `security-events/security-events-cli.ts`, `db/cli.ts` |
| Role, classification and restore lists | `db/provision-logins.ts`, `db/privilege-facts.ts`, `db/append-only-tables.ts` |
| Docs | `docs/ops/security-events.md`, `docs/auth.md`, `docs/database.md`, `docs/ops/ledger-roles.md`, STATUS, plan |

No Terraform, frontend or dependency change.

## Tests added or changed

| Test | Proves |
| --- | --- |
| `test/security-events.e2e-spec.ts` (4, runs in memory, PostgreSQL and S3 tiers, without the token mirror) | A person with no membership, a removed person and a revoked token each leave one `access.refused` with the right reason; 25 refused requests from one person leave one event; an allowed request leaves none; a download link leaves no event in this store |
| `test/db/security-events.pg-spec.ts` (14) | Owner cannot update, delete or truncate; the application login has no privilege on the table (select, insert, update, delete, truncate all refused), the auditor can only read, another privileged role cannot; the function is executable by the application role only; it records the organization and person the transaction is bound to and refuses without them and refuses every membership event type, `file.link.issued` and unknown types; the table itself has no file-link type and no report or capture subject, even for the owner; details that could carry a secret (13 shapes: unknown key, the removed link keys, URL, token, dotted name, space, over 64 characters, nested URL, extra key, wrong JSON shape, oversize) are refused while allowed shapes are accepted; the refusal throttle (one per person, organization and reason per minute, a different reason, person or organization is recorded, and a refusal older than a minute does not suppress a new one); the trigger records grant, role change, session revocation, removal and reinstatement in order with before and after roles and the operator name and **not** the free-text reason; a hand-written SQL change by the owner is recorded; a no-effect edit records nothing; when the event cannot be inserted the membership change rolls back; a write refused at commit leaves an `authority-changed` refusal with the request id; the auditor command lists newest first with only the stored fields, filters, and refuses bad input and the application login; a scan of everything the file recorded finds no token, URL, signed-link parameter, e-mail address or reason text |
| `test/db/ledger-catalog.pg-spec.ts` (+1) | The new table is classified, append-only, closed to the application and readable only by the auditor |
| Updated: migration lists in six specs, schema acceptance (keys, checks, indexes), recovery CLI migration count, privilege role lists, the M1.4 log spec and the report and capture service specs (new constructor argument) | Mechanical updates for 0018 (the migration lists now end at 0018, and the audit-guard test steps back over three migrations) |

## Defect injection

Each rule was broken on purpose, the named tests failed, and the file was restored (checked by grep).

| Injected defect | Result |
| --- | --- |
| Remove the membership trigger | 5 failed |
| Let the function use a fixed organization instead of the transaction's | 4 failed |
| Remove the append-only trigger | 1 failed |
| (Before the decision) make the link event best-effort | 1 failed; that behaviour was then removed |
| Re-allow the file-link type in the table and the function (after the decision) | 2 failed (the table has none; the function refuses it) |
| Remove the details-string check from the table | 2 failed |
| Remove the throttle | 1 failed |
| Grant the application SELECT and INSERT on the table | 4 failed (privilege, catalog and auditor tests) |
| Do not record the token-revoked refusal | 1 failed |
| Let the application write membership event types | 1 failed |

## Full local regression

Node 22.22.0, pnpm 10.28.0, frozen lockfile. PostgreSQL 16 loopback dev cluster, Moto 5.2.3. Run on the final code of the branch (after the file-link event was removed).

| Check | Result |
| --- | --- |
| `pnpm typecheck`, `pnpm lint`, `pnpm test:ci-config` (35), `pnpm test:infra` (31) | passed |
| Tier 1 backend (no database or S3 variables) | 87 suites, 1,285 passed, 201 announced service-dependent skips, 0 failed |
| Tiers 2 and 3 together (PostgreSQL + Moto), recovery suites excluded | 136 suites, 1,985 passed, 0 failed |
| Recovery rehearsal suites (3 files, 37 tests) | refuse to run as root; run as an unprivileged OS user from a copy of the repository: **37 passed** |
| Browser, in-memory API (`pnpm e2e`) | 58 + 26 passed |

Earlier on this branch, two test expectations were fixed after a first database run (the migration-runner slice count and the recovery CLI's migration count; both are listed above). The defect-injection table above and the built-command walk-through (grant, set-roles and remove producing three events, then `security-events list`) were done on the earlier stack, before the move onto `main`; they were not repeated, except the last row, which was run after the file-link event was removed. The tests that guard each rule were re-run in the full runs above.

## Limits

- **No off-site copy.** A person who can disable triggers as the table owner can still rewrite the record; the Object Lock copy that would close this is a later slice.
- File links are recorded only by the application access audit, which says "authorized and the link was created", not "the file was downloaded"; the download happens at the object store (CloudTrail's S3 data events cover that).
- Not recorded by design: sign-ins and sign-outs, role-based 403s, clinical reads.
- Refusal events are best effort: a refusal made while the database is unreachable cannot be recorded (the request is refused with 503 either way).
- The PostgreSQL browser suite (`e2e:storage`) was not re-run for this slice; it does not exercise the new paths, and that suite already has an unrelated failing test (see the M1.5 verification note).
- Nothing was run against real Cognito, RDS or a hosted environment.
