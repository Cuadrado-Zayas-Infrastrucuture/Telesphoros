# Fix: the merge decision in force is the one last in the ledger (local)

Date: 2026-10-27

Found by the 2026-10-27 audit (L1b). This is the sibling of the capture-decision fix (#94).

**The problem.** An approved merge could be recorded last in the ledger and still have no effect.
- `patient_alias_edges` keeps each source patient's newest approved decision by `seq`, which is taken at INSERT. The ledger orders events by commit, under the head lock taken afterwards.
- Example: A is merged into B. Approving "merge A into C" and "unmerge A from B" at once, the merge could insert first and commit second.
- Its commit-time check, which runs under the head lock and is correct, saw A unmerged and passed.
- Every reader then still picked the unmerge, so A never joined C's group.
- On unfixed `main`: 2 of 60 trials twice, then 8, 17 and 19 of 300.

**The fix.** `insertMergeDecision` reads the proposal's source patient and takes a per-source advisory lock before anything is written.
- Only decisions on the same source compete in `patient_alias_edges`, so one lock suffices and there is no lock-ordering question.
- The commit-time rule and the migrations are unchanged.

**The test.** `test/db/merge-decision-order.pg-spec.ts` runs 300 trials of that scenario, alternating which decision starts first.
- It requires the patient's merged-into to match the ledger-last decision.
- A control requires that some trials approved both decisions, so the race was reached.
- Red without the lock in three of three runs; green with it in three of three, about 13 s each.

**Side effect.** Because the lock comes before the "already decided" lookup, two identical decisions on one proposal made at once now replay rather than answer 409.

**Not covered.** A worker reclaiming its own expired job (W2) is separate.
