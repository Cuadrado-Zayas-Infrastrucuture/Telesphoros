# Synthetic report revision inspection (032 S2b1)

Date: 2026-11-02
Status: Bounded continuation of the founder's PGx implementation request and “continue” after #262. Independent branch from main; no dependency on that open PR.

## Scope and decisions

Implement a pure, bounded inspection function beside the S1 shared contracts. Given an explicit tenant/patient scope and up to 100 source snapshots, classify each laboratory/report series as held or as a candidate for independent review. Validate every snapshot with the existing strict laboratory-report schema. Reject mixed internal tenant/patient scopes and duplicate internal source IDs before returning anything. The caller must already have authorized the records and verified their exact object bytes; this function cannot authenticate a laboratory or prove a supplied hash.

Group by laboratory and series, retaining every source reference. Identical revision content and SHA-256 may be duplicate uploads with different internal IDs/object versions. A changed hash or laboratory payload at the same revision holds the whole series. A laboratory report ID reused across revisions/series, or an accession reused across series from the same laboratory, also holds the affected series. Different laboratories remain separate; they never compete on newest timestamp or automatically form a patient profile.

A candidate requires an unbroken revision sequence starting at 1, exact predecessor IDs, stable source patient reference/accession/specimen, nondecreasing issue times, no successor to a cancelled/entered-in-error revision, and an eligible terminal status (final/amended/corrected). Missing predecessors, gaps, branches, identity drift and withdrawn/preliminary latest records yield explicit holds, never fallback to an older revision. Input order and object-key order cannot change results; finding/array order is preserved as source content. Report IDs and source IDs are references, not inferred patient matches.

Return a versioned inspection result with sorted sources/revisions and reason codes. A candidate names only the latest revision's exact sources and finding IDs; missing, untested and ambiguous findings are never backfilled from older revisions. Always mark synthetic, non-actionable, clinical-use-not-approved, independent-review-required and patient-profile-not-reconciled. No source data or caller object is mutated.

## Boundaries

No API, storage/migration, ledger writes, review acceptance, UI change, automatic patient linkage, normalized finding registry, assessment, guideline content, PDF reader, inference or deployment. This provides the deterministic conflict/lineage rules for later transactional intake; it does not implement A09 idempotent persistence or A10 review tasks/current-basis concurrency. Issuer qualification, analytic acceptance, cross-report finding selection and all clinical policy decisions remain separate.

## Verification

Write failing public-export tests before implementation. Independently specify duplicate/conflict cases, complete and out-of-order amendment chains, gaps/branches, status withdrawal, identity drift, source-bound references and cross-laboratory separation. Exercise all permutations of a small history, unknown fields, input bounds and unchanged inputs. Remove the scope and duplicate-content guards in isolated worktrees and require their refusal tests to fail. Run the full shared-contract suite, required workspace typecheck/lint/test/build, infrastructure and CI configuration guards. No database, storage, browser or clinical acceptance is claimed for this pure function; those boundaries are unchanged and must be exercised when integration is built.
