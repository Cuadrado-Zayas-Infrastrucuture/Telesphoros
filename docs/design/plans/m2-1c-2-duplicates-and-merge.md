# M2.1c-2: duplicate review and merge (implementation note)

Status: **built on a local branch (`claude/m2-1c-2-duplicates-merge`, stacked on M2.1c-1; not pushed, no pull request).** This is the second half of the approved [M2.1c plan](m2-1c-wrong-chart-and-duplicates.md); the founder approved DQ-1 to DQ-8 on 2026-10-14 and asked to start M2.1c-2 on 2026-10-14. This note records how the plan was made concrete and where the build differs from it. Evidence is in [`docs/verification/m2-1c-2-duplicates-merge.md`](../../verification/m2-1c-2-duplicates-merge.md). Synthetic data only; nothing here lifts the BAA or clinical hold.

## What is built (as the plan says)

- `patient_duplicate_flags`: one row per unordered pair of patients whose identifiers collided. The `409 identifier-in-use` answer is unchanged and stores no identifier; it now also leaves a flag (system code and who hit it, no number, no digest).
- `patient_merge_proposals` and `patient_merge_decisions`: two ledger records (event types `patient-merge-proposal` and `patient-merge-decision`). The decision is made by someone other than the proposer (a trigger). One decision per proposal.
- Merge and unmerge are **derived**: an approved `merge` makes the source an alias of the target; an approved `unmerge` of that pair ends it. No `patients`, `reports`, `evaluations` row is rewritten and no `tenant_id` or `patient_id` moves.
- Reads resolve a patient's group (the root and its aliases): `GET /patients` hides merged-away patients unless `includeMerged=true` and carries `mergedInto`; the `patientId` filter of reports, evaluations and recommendations means the whole group; an identifier registered on any patient of a report's patient's group verifies the link; `POST /reports` and `POST /patients/:id/identifiers` onto a merged-away patient answer `409 patient-merged`.
- Routes: `GET /patient-duplicates`, `POST /patient-merges`, `POST /patient-merges/:id/decision`, `GET /patient-merges`, `GET /patient-merges/:id`. Propose and decide: `clinician` or `reviewer`; an administrator alone has none of them.

## Where the build differs from the plan

1. **Groups are one level deep (a root and its direct aliases), so reads need no recursion.** The plan allowed a chain found with "a recursive query bounded in depth". The database instead refuses a merge whose source *has aliases of its own* (`source-has-aliases`): merge the other root into it, or unmerge first. A chain therefore cannot be written, the "bounded recursion" has nothing to bound, and every group lookup is a join. This is stricter than the plan, not looser; if chains are wanted later it is a new migration and a recursive query.
2. **The graph rules are enforced by one SQL function used in two places.** `patient_merge_refusal(...)` returns the reason a merge or unmerge may not happen (`source-merged`, `target-merged`, `source-has-aliases`, `not-merged`, `patient-gone`) or NULL. A *deferred constraint trigger* on the decision table calls it at COMMIT, which is after the decision's ledger event took the tenant's head lock and before it is released, so two decisions cannot both pass on a stale picture. The service calls the same function when a merge is *proposed* so an impossible proposal is refused early (409 with the reason); the decision-time check is the guarantee.
3. **Merges exist only with the lab-report pipeline on PostgreSQL**, like every ledger record (there is no in-memory ledger). The duplicate flags do not depend on the ledger and work in memory too. Without merges every patient is its own group, so the in-memory read paths are unchanged.
4. **A declined merge proposal dismisses the pair** (DQ-8): the pair leaves `GET /patient-duplicates` and a later collision does not bring it back. It is derived from the decision; the flag row is never edited.
5. **A second proposal for the same pair and kind while one is undecided is refused** (`409 proposal-pending`), by the service. Two simultaneous identical proposals are harmless (each is decided on its own).

6. **0021 also widens M2.1b.** An identifier match may name an identifier of *any patient in the report patient's group*, not only the patient itself (otherwise a number registered on the surviving record could not verify a report still written for the merged-away one). The trigger `report_patient_decisions_check()` and the foreign key (now `(identifier_id, tenant_id)` onto a new `patient_identifiers_id_tenant_uq`) change; the decision still names the report's own patient. The down migration restores the 0020 rules and fails on a database that holds such a decision.

## Not in this slice

Screens (M3.2), un-dismissing a pair other than by a new proposal, merging across organizations (impossible: every key carries `tenant_id`), chains of aliases, any change to the ledger's hash format or the projection of an existing record, extraction from report text.

## Known limits to carry into the verification note

- Retention (M0/T01): whether a merged patient's records must stay individually retrievable. The alias design keeps every row, so `includeMerged=true` and the unfiltered record reads already show them; a "pre-merge view" would be a later requirement.
- Merge decisions authorize nothing clinical by themselves: they change what a patient-scoped read returns. An evaluation made for a report stays pinned to the patient the report names.
