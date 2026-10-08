# Ledger golden vectors

`ledger-golden-vectors.json` holds known answers for the three hash formulas of the audit ledger
(`docs/design/records-and-corrections.md`, section 6). They were computed **once, by a separate implementation written in Python from the
specification text only**, never by the TypeScript or SQL code they test. A bug that is in both the writer and the verifier
(because one was copied from the other) cannot hide here.

What the generator did (about thirty lines of Python, not committed because Python is only allowed under `ml/training/` and `sidecars/`):

1. **Canonical JSON** (RFC 8785 style, integers only): object keys sorted by UTF-16 code units
   (`key.encode("utf-16-be")`), no whitespace, strings escaped like `JSON.stringify` (`ensure_ascii=False`).
2. **Payload hash** of an event: `sha256(canonical JSON of the projection)`, lower-case hex.
3. **Event hash**: `sha256(UTF-8 of tenant, seq, type, table, subject, actor, payload, projection version, hash version, previous hash,
   created-at)` joined with `U+001F`; `created-at` is `YYYY-MM-DDTHH:MM:SS.ffffffZ` (UTC, microseconds); genesis previous hash is 64 zeros.
4. **Checkpoint payload**: `sha256(id, tenant, up_to_seq, head_hash, mode)` joined with `U+001F`.
5. **Redaction payload**: `sha256("<note id>:<body sha256>:<basis code>")`.

The vectors include non-ASCII and astral-plane text (an emoji in an actor name, an emoji key that must sort *before* U+FFFF in UTF-16 order
although it is larger in code points) and the last second of a year. `ledger-golden.spec.ts` recomputes every value with the production
functions and compares. To change a formula, bump `HASH_VERSION` / `PROJECTION_VERSION`, add new vectors, and keep the old ones.
