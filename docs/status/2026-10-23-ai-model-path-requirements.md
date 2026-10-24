# Requirements recorded for any future model path (2026-10-23)

Date: 2026-10-23

**Implemented (documentation only).** `docs/ai-safety-and-hallucination-controls.md` now holds two requirements for the first change that adds a model call. R1: every model task declares its data class (`phi` or `no-phi`) in code, a `phi` task refuses rather than falling back to a provider without a business associate agreement, and a test fails when a task's class disagrees with its sanitizers or provider filter. R2: every output guard has a production caller, and a test fails when one has none. Both come from a review of an earlier gateway prototype, where a task was labelled `no-phi` while its prompt held one patient's medication list, and an output guard was unit-tested but never called.

**Not changed:** code, CI, the ruleset, `docs/STATUS.md`, or the rest of the safety document. The repository still has no model client, so neither requirement has a test yet. The two sentences already in the document, including the `PGX_CLINICAL_HOLD_LIFTED` line, are unchanged; nothing in the code reads that flag today, because there is no AI layer to gate. Further review findings (an evaluation gate that runs only after merge, unguarded free-text outputs, retention of cached PHI responses) are not recorded here.
