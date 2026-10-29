# Feature Specification: a refusal made after the request's capability expired is still recorded, as that person

**Feature Branch**: `docs/spec-015-security-event-grace` (spec only; the implementation gets its own branch off `main`)

**Created**: 2026-10-29

**Status**: Approved 2026-10-29 ([plan.md](plan.md), D1 to D3 as recommended). Direction set by the founder on 2026-10-29: option A, a grace window on the recording of security events, rather than asking the issuer again or accepting the loss.

**Input**: audit item A3 (2026-10-27). Its security-events half was fixed for the `guc` and `dual` binding modes in #127, which left the `capability` mode open (`docs/status/2026-10-28-security-event-expired-capability.md`). A PostgreSQL check on 2026-10-29 confirmed the gap.

Line numbers cite `main` `15f02752`.

## The problem

- **A security event takes its organization and person from the capability.** `security_event_append` reads `public.app_tenant_bound()` and `public.app_actor()` (`0032_tenant_binding_policies.up.sql:257-284`, repointed by `0047_active_tenant_binding.up.sql:88-100`). Both return nothing for a capability that has expired (`0028_tenant_capability.up.sql:198-222`, `0047:23-46`), and the function then refuses with `42501`.
- **A request's capability lasts 60 seconds** (`0028:58-61`, purpose `request`), but a request can run for minutes: an upload is held to progress deadlines, not a total time, and Node's default `requestTimeout` is 300 s (`app.factory.ts:86-89` sets only `headersTimeout`).
- **So some refusals come after the capability has expired.** An intake refused as `timeout` or `slow` after a long upload (`intake.service.ts:218`), and the `authority-changed` refusal of a long write at commit (`database.ts:119`).
- **In `dual` mode they are recorded today, unproven.** #127 drops an expired capability before the write (`authority-context.ts:109`, `security-events.ts:90`), so the function falls back to the settings the application set: the right organization and person, but on the application's word.
- **In `capability` mode they are lost.** There is no fallback: the write is refused, and the application logs `security-event-not-recorded` at `error`. Checked on PostgreSQL 16 on 2026-10-29 (expired capability and no capability refused with `42501`; valid capability recorded; the binding mode proven by a row-level-security read that returned rows only under a valid capability).
- **Admission refusals are not affected.** When the issuer refuses a person who is not current, its own log row records it (`auth.guard.ts:53-55`, decision D1 of spec 001).

**Rule:** a refusal is recorded under the capability the request was issued, as long as that capability is not revoked and expired no longer ago than the grace window. The organization and the person always come from the capability, never from the application's settings.

## Out of scope (v1)

- Moving `tenant_binding_mode` to `capability`. This spec removes one obstacle; the move is its own change.
- Any other use of an expired capability: reads, writes, the other three repointed functions (`membership_assert_current`, `member_sign_out`, `member_admin_context`). The grace applies to recording a security event and to nothing else.
- Refusals made with no capability at all (an issuer that could not be reached, for example). They stay refused in `capability` mode, as today; admission refusals are the issuer's. Whether such a request should run at all in that mode belongs to the move itself.
- The issuer, spec 012's job capability, and the capability lifetime.

## User Scenarios & Testing

### User Story 1: a refusal after a slow upload is recorded as the person who uploaded (Priority: P1)

A clinician's upload runs past the request's capability and the intake refuses it as `slow`. The refusal is recorded for that clinician in that organization, in `capability` mode as in `dual`.

**Independent test**: on PostgreSQL in `capability` mode, issue a capability, age it so it expired 2 minutes ago, record an intake refusal under it, and read one `intake.rejected` row for that organization and person.

**Acceptance scenarios**:

1. **Given** `capability` mode and a capability that expired within the grace window, **When** an intake refusal is recorded under it, **Then** one row is written with the capability's organization and person.
2. **Given** the same, in `dual` mode, **When** the refusal is recorded, **Then** it is written the same way, from the capability, not from the settings.
3. **Given** a long write refused at commit after the capability expired, **When** `authority-changed` is recorded, **Then** it is written for that person.

### User Story 2: the grace gives nothing else (Priority: P1)

**Acceptance scenarios**:

1. **Given** a capability that expired longer ago than the grace window, **When** a refusal is recorded under it, **Then** the database refuses it (`42501`) and the application logs `security-event-not-recorded`.
2. **Given** a revoked capability, **When** a refusal is recorded, **Then** it is refused.
3. **Given** a capability for one organization and settings naming another, **When** a refusal is recorded, **Then** it is refused, as today.
4. **Given** a capability within the grace window, **When** the transaction reads or writes any clinical table, **Then** row-level security sees no organization, as today.
5. **Given** `capability` mode and no capability, **When** a refusal is recorded, **Then** it is refused, as today.

### User Story 3: nothing changes for a request whose capability is still valid (Priority: P1)

A refusal under a valid capability is recorded exactly as today, in every mode, and the per-minute throttle still holds.

## Requirements

- **FR-001**: The database records a security event under a capability that is not revoked and expired no more than the grace window ago, taking the organization and person from it.
- **FR-002**: The grace applies only inside `security_event_append`. `app_tenant_bound()`, `app_actor()`, every policy and every other function are unchanged.
- **FR-003**: The grace window is fixed by a migration, never by a setting the application can change, and is no longer than the retention of `tenant_capabilities_sweep` (5 minutes, `0028:228-246`), so a capability inside the window still exists to be checked. A guard fails if the two drift apart.
- **FR-004**: The application stops dropping an expired capability before recording an event (`withoutExpiredCapability`), so the event is attributed from the capability in `dual` mode too. An event that still cannot be recorded is logged at `error`, as today.
- **FR-005**: The migration has a down file that restores the current function exactly, and refuses to run if the function is not the one it expects, as 0047 does.

## Success Criteria

- **SC-001**: On PostgreSQL in `capability` and `dual` mode, a refusal under a capability expired within the window is recorded with the capability's organization and person; seen failing before the change in `capability` mode.
- **SC-002**: Under a capability expired past the window, a revoked one, or one for another organization, the refusal is refused in both modes.
- **SC-003**: Under a capability within the window, a read of a clinical table returns no rows: the grace reaches nothing but the event.
- **SC-004**: The existing security-event specs pass unchanged, including `security-event-expired-capability.pg-spec.ts`.
- **SC-005**: The guard of FR-003 fails when the window is set longer than the sweep's retention.
