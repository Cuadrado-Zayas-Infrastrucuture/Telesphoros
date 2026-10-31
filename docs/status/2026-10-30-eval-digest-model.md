# The evaluation gate's harness version now covers the model and its limits

Date: 2026-10-30

**Implemented.** Spec 003 FR-010 says a change to the model ID, the SDK version or a decoding setting changes the harness
version. The gate's digests covered the prompt templates, the lexicon and the glossary only. They now also cover the
identity of the client every case runs through (model ID, invocation path, SDK version) and its limits: `EXPLAIN_LIMITS` and
the per-call output caps, which moved from two inline numbers in `explain.ts` into `OUTPUT_CAPS` with the same values.
`evals/pinned.ts` pins both, so a model swap or a raised cap turns the gate red until it is re-measured and re-pinned in a
reviewed diff. The gate's measurements did not change: 34 cases (0 wrongly released, 0 reason mismatches) and 18 attacks
(0 effective), before and after. The harness version moved from `sha256:f468c6f4…` to `sha256:5fe69b72…`.

**Not established.**
- The gated client is still the scripted stand-in (`scripted-v1`). When the Bedrock adapter (T033) lands, its exact model
  ID becomes the pinned identity.
- The request carries no temperature or other sampling setting; if one is added, it belongs in the limits digest too.
