# Release runbook: migration 0034 is `breaking` in effect (2026-10-24)

Date: 2026-10-24

**Implemented (docs only).** The decision on audit items 15 and 16 was to leave the four migration files alone and cover 0034's live-deploy risk in the release runbook; the lint rules shipped in PR #12, but the runbook note did not. `docs/ops/api-hosting.md`, "Classify the release", now says that 0034, labelled `expand`, makes an older running image return `PM002` as a server error instead of a 409 and takes a lock with no `lock_timeout`, that it matters only when a task predating 0034 is running while it is applied (not for a first release into an empty database), and that such a release should be treated as `breaking`.

**Not changed.** No migration, no lint, no code. 0020 and 0021 (the other two files the audit named for missing `lock_timeout`) are not mentioned there: they predate the label, and their `ALTER TABLE ledger_events` locks would matter only on a populated ledger; nothing is deployed yet, so there is none.

**Limits.** The two statements about locking and the older image rest on 0034's own header and on PostgreSQL's documented lock for `CREATE TRIGGER`; neither was exercised against a running older image.
