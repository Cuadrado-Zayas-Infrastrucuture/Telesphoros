# Two knowledge signers must hold two keys

Date: 2026-11-10

The two-signer rule for real knowledge files counted signers by key id. A trust list that gave two key ids the same public key therefore let one key satisfy it. The Terraform in `knowledge-signing.tf` never builds such a list (one KMS key per signer, one principal per signer), so this closes the gap for a `KNOWLEDGE_SIGNER_KEYS` value set any other way.

`apps/backend/src/services/knowledge/signatures.ts` now refuses it in two places. `parseSignerKeys` refuses a trust list in which two ids hold one key, naming the two ids and never the key. `checkSignatures` counts two signatures made with one key as one signer, so a caller that builds the trust list itself is covered too. Keys are compared by their public point, not by their text or bytes: the same key with its point compressed, or given as its private half, is still the same key, and a different key that shares one coordinate is still a different key.

Nothing else changes: the signed message, the number of signers, the schema and the Terraform are as they were. Distinct keys do not prove two people; that remains a matter of who holds each key.

Tests: `signatures.spec.ts` and `knowledge-loader.spec.ts`. Each of the two checks, and the comparison itself, was removed in turn and a test failed each time.
