# Spec 020 E1b: use eligibility records and `use-eligibility-v1` (local)

Date: 2026-10-30

**What it adds.**
- Five ledgered records (migration 0063): `use_grants`, `use_grant_validations`, `use_withdrawals`, `use_restrictions` and `tenant_use_terms`.
- The SQL function `use_eligibility(tenant, patient, purpose, scope, classification, fact kind, fact id, at)`, policy version `use-eligibility-v1`. It answers eligible or not, the sorted reason codes, the ids of the records it relied on, the grant's legal authority and the classification.
- `use_eligibility_lock(tenant, patient)`: the per-patient lock a use takes before it asks, in a fresh statement.

**What it guarantees, and where.**
- **Fails closed.** Fourteen reason codes, each tested: unknown purpose or classification; no terms in force, or terms that do not authorize the purpose or classification; no grant, or one not yet effective, expired, withdrawn or unvalidated; a restriction in force; a jurisdiction not on the allowlist; a fact whose origin is unknown, or a `real` fact for any purpose but clinical care.
- **Synthetic only.** The v1 allowlist holds only the synthetic jurisdiction `ZZ`. A real jurisdiction needs counsel, a new migration and a new policy version. No API, route or command writes these records; tests and seed fixtures do.
- **Past answers stay reproducible.** Every record counts only from the time it was recorded, so a later grant, even one back-dated, does not change an earlier answer.
- **A withdrawal is never missed.** Grant, validation, withdrawal and restriction writes take the per-patient lock, and a withdrawal is never effective before its recording time.
- **Recording is not validating.** A grant is inactive until a second person validates it.
- **Append-only, ledgered.** UPDATE, DELETE and TRUNCATE are refused; FORCE row-level security; one ledger event each; the chain verifies.

**What it does not do.**
- No grants API (E3, waits for counsel), no operator command for tenant terms (E2), no patient-facing form.
- No per-use decision record and no release logic: D07 consumes the answer.
- `event` expiry is refused until a later slice records the event. Tenant terms take no lock: a later version supersedes, and nothing ends terms early.

**Rollout.** The verifier reads every record table, so the migration and the verifier ship together.

Evidence: `docs/verification/use-eligibility.md`.
