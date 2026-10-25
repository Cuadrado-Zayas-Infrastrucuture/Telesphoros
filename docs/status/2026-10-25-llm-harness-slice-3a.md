# LLM harness slice 3a: outcome v2, trace and receipt, keyed digests, real usage

Date: 2026-10-25

**Implemented.** Every run of `runExplanation` now leaves a trace and a receipt, and returns them with the outcome. The receipt is outcome v2 (`src/outcome-v2.ts`): the run id, tenant and requester, the terminal state, a fixed reason code and detail codes, the harness version, the model's pinned identity, the template digest, **keyed (HMAC-SHA-256) digests** of the evidence and of the last model output, the guards that ran, and counters (slots, calls, input and generated units, usage known or unknown). It has no field for text, and every string it can hold is a digest, a code, an id or an enum. The trace (`src/trace.ts`) records each step's name, state, fixed code, duration and usage so far. `src/keyed-digest.ts` holds the HMAC and a canonical JSON; the key (at least 32 bytes) is passed in through the ports and is never read from the environment. `ModelPort` gained a required `identity`; a model id must be a dated, versioned id, never an alias. Usage is read from the provider's report; a call that began and did not report leaves the usage unknown, and a release never has unknown usage.

**Controls.** A scan test runs all 34 golden cases and a failing run with a hostile model reply and finds no result text, phenotype, gene, drug, model word or key in any trace, receipt or outcome record, with a leaky control showing it can fail. Broken on purpose, each red: a trace step carrying engine text, the keyed digest degraded to a plain hash, outcome v2 allowing extra keys, usage always reported as known (see `docs/verification/llm-harness-slice-3a.md`).

**Not changed:** the engine, `kernel.ts`, `contracts.ts`, `index.ts`, migrations, Terraform, the AWS account. Nothing is stored anywhere yet.

**Not done (slice 3b):** the migration, the PostgreSQL store, the fleet and tenant caps under concurrency (T025), retention and purge for receipts, and the database half of R5. The receipt is returned to the caller; nothing writes it to a table. The digest key is a test value in tests; the real one comes from the secrets store at the composition root.
