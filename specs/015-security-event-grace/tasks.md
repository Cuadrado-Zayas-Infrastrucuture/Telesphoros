# Tasks: a refusal made after the request's capability expired is still recorded, as that person

**Input**: [spec.md](spec.md), [plan.md](plan.md)

**Prerequisites**: plan.md **approved by the founder** on 2026-10-29 (D1 to D3 as recommended).

**Tests**: Required (SC-001 to SC-005). Each check is seen failing before the change that makes it pass.

**Organization**: One phase, one PR off `main`, kept local until the founder says push.

## Format: `[ID] [P?] [Story] Description`

## Phase 1: record under a recently expired capability

- [ ] T001 [US1] Write `test/db/security-event-grace.pg-spec.ts`: in `capability` and `dual` mode, an intake refusal under a capability expired 2 minutes ago is recorded with its organization and person. Run it: red in `capability` mode.
- [ ] T002 [P] [US2] In the same spec: expired 6 minutes ago, revoked, another organization in the settings, and no capability in `capability` mode are all refused (`42501`); under a capability within the window, a clinical-table read returns no rows.
- [ ] T003 [P] [US3] In the same spec: a refusal under a valid capability is recorded once, and a second within a minute is throttled, as today.
- [ ] T004 Read the live `security_event_append` with `pg_get_functiondef` on a migrated database; write the migration (next free number) adding `security_event_capability()` and replacing the function's two lookups, refusing if the definition is not the expected one; write the down file restoring the definition read.
- [ ] T005 [US1] `Database.recordSecurityEvent` (D2) and `PostgresSecurityEvents` on it, without `withoutExpiredCapability`; remove the helper and its test if nothing else uses it.
- [ ] T006 [P] The guard of FR-003: grace no longer than the sweep's retention, with a 10-minute control that must be reported.
- [ ] T007 Run T001 to T003 green; `security-event-expired-capability.pg-spec.ts` and the other security-event specs unchanged; the migration up, down and up again as the migrator; the full backend suite on PostgreSQL and Moto; typecheck and lint.
- [ ] T008 A `docs/status/` fragment; correct the "Open" paragraph of `docs/status/2026-10-28-security-event-expired-capability.md` by pointing to it.
