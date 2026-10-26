# Fixed-schema phase evidence for the intermittent readiness test

Date: 2026-10-26

The existing database-disappearance readiness case now writes start/returned/threw records for fixture creation, app startup, healthy readiness, database drop, failed readiness and liveness. A test-only helper writes small JSON lines directly to native stderr, bypassing Jest's buffered console. Records contain only a fixed diagnostic/version code, sequence, allowlisted phase/event and rounded monotonic elapsed time; no callback value, error object, token, report value or database identifier is serialized.

This is diagnostic evidence, not a repair or a flake declaration. Original callbacks, assertions, five-second test deadline, production two-second dependency deadline, fixture cleanup and CI routing/budgets are unchanged. A late returned record does not turn a timed-out Jest test into a pass.

Four observer controls first failed against a pass-through observer, then passed after recording was implemented. All 27 focused observer, real-PostgreSQL readiness, timeout and health tests passed. The real test emitted all twelve expected native-stderr records in order, with the exact fixed schema. Broader candidate acceptance is recorded separately. Synthetic data only; no product, engine, model, schema, safeguard or deployment change.
