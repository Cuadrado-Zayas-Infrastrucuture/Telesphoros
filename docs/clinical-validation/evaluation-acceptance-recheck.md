# Evaluation acceptance recheck

An evaluation could pass the BEFORE INSERT acceptance check while a newer capture decision was uncommitted, then wait for that decision's ledger lock and commit after it. The insert trigger alone did not serialize freshness.

New evaluation writes now read the latest acceptance in a separate READ COMMITTED statement after their ledger append. Capture decisions use the same tenant lock, held until COMMIT. If a newer decision committed first, the evaluation and its ledger event roll back with HTTP 409, reason `stale-acceptance`. If evaluation obtained the lock first, the later decision waits; the committed evaluation remains historical evidence.

The check applies to new evaluations naming an acceptance, including held evaluations. Historical pre-acceptance holds with a null acceptance and existing repository replay behavior are unchanged. The HTTP service still rejects a stale decision before processing where visible; this change protects new persistence against the later race. No schema migration, clinical routing, knowledge, production or training switch changes.

Verification uses a disposable PostgreSQL 16 database and the restricted application role. A barrier pauses a newer decision before COMMIT and observes the evaluation waiting on the ledger lock. The unfixed rejection-first test failed because evaluation succeeded. The fixed tests cover both superseding rejection and acceptance, no surviving evaluation/event, and evaluation-first history preservation. Existing dispute and endpoint/persistence regressions remain separate controls. S3 was not configured locally; required CI supplies the storage tier.
