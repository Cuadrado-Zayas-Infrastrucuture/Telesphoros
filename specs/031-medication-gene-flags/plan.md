# Draft plan: medication–gene review flags

Follows [the draft spec](spec.md). No implementation is authorized by this plan.

1. Founder names a clinical signer and resolves the six product decisions. Record intended use, excluded outputs and source/distribution rights; do not infer approval from medication capture being merged.
2. Prepare a versioned clinical validation protocol and independent source fixtures before an implementation PR. Resolve exact RxCUI mapping in signed knowledge, multi-gene/population input, valid-result/acceptance selection and invalidation semantics with the existing engine owners. No name-based shortcut.
3. After approval, propose separate engineering slices: signed-content contract and tests; tenant-scoped deterministic eligibility/result contract behind a default-off reviewed gate; compact clinician/read-only UI and evidence; release validation. Revisit MD-6 explicitly in the approved slice, preserving the capture-only default and clinical hold until gates are met.
4. Use the existing real dependency harness for database/RLS/ledger checks. Verify every hold with deliberate missing/corrupted/stale evidence. Source expectations come from versioned independent fixtures, never from the implementation under test or a model.
5. Clinical signer reviews the complete evidence and approves a specific content/version/intended-use combination. Founder separately reviews and authorizes a release plan. Neither this draft nor green CI grants clinical approval.
