# Fix: the current capture decision is the one last in the ledger (local)

Date: 2026-10-27

Found by the 2026-10-27 audit (L1).

**The problem.** When two reviewers decided on one capture at the same time, the earlier decision could stay "current":
- A rejection that the ledger records last could lose to an acceptance, and evaluations were then allowed on rejected text.
- `latestAcceptance` and the evaluation gate pick the newest row by `seq`. That number is assigned at INSERT, while the ledger orders events by commit, under the head lock taken afterwards.
- Nothing serialized two decisions on one capture before the INSERT.
- With no pause injected, 12 of 60 and 2 of 60 concurrent reject/accept pairs disagreed.

**The fix.** `insertAcceptance` now takes a per-capture advisory lock before the INSERT. This mirrors the patient-link lock.

**The test.** `test/db/capture-decision-order.pg-spec.ts` runs 60 concurrent pairs and requires 0 disagreements:
- Without the fix it fails, with 2 disagreements.
- With the fix it passes.

**Not covered.** The same gap in merge decisions (`patient_alias_edges`, audit L1b) is not fixed here.
