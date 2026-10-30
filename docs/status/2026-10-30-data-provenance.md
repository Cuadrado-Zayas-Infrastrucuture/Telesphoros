# Spec 020 E1a: data provenance (local)

Date: 2026-10-30

**What it adds.**
- A ledgered record, `data_provenance`, that says where one fact came from. It is written for every new report capture and every new evaluation, in the fact's own transaction. Migration 0062.
- For a capture: the PDF's sha-256 and object version, the report's upload time, the text runner and Poppler version, and the report as parent.
- For an evaluation: `software-derived`, the capture's PDF hash, the engine version and knowledge set, and the capture acceptance as parent (the capture itself when the evaluation relied on no acceptance).

**What it guarantees, and where.**
- **Origin is the server's.** `currentDataOrigin` answers `synthetic` only outside production with the pipeline enabled, and throws otherwise. The services ask it before any file is read; the repository checks again; the column has no default. A request field never sets it.
- **No `real` yet.** The database allows `real`, so admitting real data is a decision in code, not a migration. No code path writes it.
- **One per fact, never rewritten.** Unique per capture and per evaluation; UPDATE, DELETE and TRUNCATE refused; FORCE row-level security; one ledger event each. A repeated or raced write of an existing fact adds nothing.
- **Same organization.** A trigger binds the row to the transaction's person and checks its parent asset exists in the same organization.
- **The chain verifies across the migration.** A tenant with facts from before 0062 (no provenance) and after (with it) verifies; altering a provenance row turns the check red.

**What it does not do.**
- Facts stored before 0062 get no provenance row: their origin was never recorded, and a guessed one would be false.
- Source organization, source type, context and collection location stay null: nothing collects them yet.
- No purpose, consent or eligibility: those are E1b's records, which this one links to and never encodes.
- `reports` rows carry none; a capture's parent is its report.

**Rollout.** The verifier reads every record table, so the migration and the verifier ship together, as they did for 0060.

Evidence: `docs/verification/data-provenance.md`.
