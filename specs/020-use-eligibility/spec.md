# Feature Specification: Use eligibility, whether a patient's data may be used for a purpose at a time (D05)

**Feature Branch**: `docs/spec-020-use-eligibility` (design only; no code, migration or test in this spec)

**Created**: 2026-10-28

**Status**: approved for slices E1a and E1b only. The founder accepted decisions E1 to E8 in [plan.md](plan.md) as recommended on 2026-10-29. E2 (the operator command for tenant terms) and E3 (the grants API, which waits for counsel's form) are not authorized. Nothing is built or sent to counsel. Tasks: [tasks.md](tasks.md).

**Input**:
- The founder's 2026-10-27 data-product report. It is quoted in spec 006 [research.md](../006-clinician-decision-records/research.md), rows R15, R19 and R21. Its own D05 section was not available when this was written and is marked unverified here.
- The founder's review of spec 006. It says *"D05 policy design proceeding alongside"*, that D05 *"establishes the authority required for future commercial releases"*, and that *"Aggregation alone will not resolve release privacy"*.
- The 2026-10-19 plan [pgx-data-model-and-data-products.md](../../docs/design/plans/pgx-data-model-and-data-products.md): the zones, the two gates, the invariants, Appendix A (questions for counsel) and Appendix B (the `consent_record` and `tenant_data_terms` sketches).

## Why

A clinical record may be used for the patient's care. Every **other** use needs authority that the system does not hold today: research, an aggregate data product, or a report to a payer-sponsored program. No such authority is recorded anywhere. Today, "eligible" in the code means only *clinically decidable*, as in spec 006's `cdr-eligibility-v1`. The data-product roadmap needs a second, separate notion: *usable for purpose P at time T*. Without it, the release step (D07) cannot be built honestly, and no real patient's data may enter a data product.

## What is eligible to be used at all (founder, 2026-10-28)

> *"We will not store raw data, for research purposes a curated database has way more value."*

So no raw genomic data (VCF files, sequences or variant calls) is stored, and no purpose here applies to any. Research and aggregate products are built from the **curated record**:
- the lab-reported results as captured and accepted;
- the engine's evaluations, with their knowledge-set provenance;
- the clinician decisions (spec 006), presentation events (spec 019) and later outcomes.

Use eligibility governs which of those curated records may enter which use.

## What "eligible for use" means here

A **use-eligibility answer** says, for one patient fact, one purpose and one instant:

- **eligible**, or **not eligible**, with a reason code for each failed condition;
- the policy version it was computed under (`use-eligibility-v1`);
- the records it relied on (the terms version, the grant, any restriction), so a past answer can be **reproduced**, not just recomputed.

It is **not** the clinical eligibility of spec 006. A result can be clinically decidable and still not usable for research, and the reverse.

## Requirements

- **FR-01 Two independent gates.** A use needs (a) the **tenant's agreement** to authorize that use for the period, and (b) the **patient's grant** for that purpose and scope, valid at the instant. Either one missing means not eligible. This restates invariant 4 of the 2026-10-19 plan.
- **FR-02 Intervals, not "the latest row".** Grants, withdrawals, terms and restrictions each have an effective interval. The answer for instant *T* reads the records in force at *T*. A later withdrawal never rewrites the answer for an earlier instant, and an earlier export stays explainable. This replaces the 2026-10-19 sketch's "latest consent".
- **FR-03 Fails closed.** Unknown purpose, unknown jurisdiction rules, a missing form version, an expired grant, or data whose origin is unknown or real while no BAA is in force: each means not eligible, with a reason.
- **FR-04 Withdrawal cannot be missed.** A use that runs inside a transaction (an export, a program report) checks eligibility **after** taking the same lock a withdrawal takes, as `cdr-eligibility-v1` does with the ledger lock. Both race orderings are tested.
- **FR-05 Append-only and attributable.** Every grant, withdrawal, terms version and restriction is a ledger record. It names who recorded it and in what capacity: the patient, a legal representative, clinic staff attesting a paper form, or an operator for tenant terms.
- **FR-06 Clinical care is not gated by D05.** Treatment use needs no grant here, but it is recorded as a purpose so that every answer names one.
- **FR-07a No raw data.** A use may draw only on curated records. No raw genomic input exists to draw on, because none is stored (founder, 2026-10-28).
- **FR-07 Data origin.** Every fact used by a product carries its origin: synthetic, or real. Real-origin facts are refused for any purpose other than clinical care until a BAA and the founder's real-data gate are both in force. The founder decided on 2026-10-21 that the BAA is not executed while data is synthetic only, and is required before any PHI.
- **FR-08 No release semantics.** Eligibility says whether a record may **enter** a use. It says nothing about whether an output built from eligible records may be **released**. Disclosure control, such as minimum cells or differencing across overlapping outputs, belongs to D07 and counsel.

## Out of scope

- Consent capture screens and patient-facing forms.
- Any export, zone D table, payer-program table or release.
- De-identification method choice (Safe Harbor or Expert Determination).
- Legal conclusions. Every legal question is listed for counsel in [plan.md](plan.md#questions-for-counsel), unanswered.

## Success criteria (for the later build, written now so the design can be judged against them)

- SC-01: the answer for any (fact, purpose, instant) can be reproduced from stored records alone, after any number of later grants or withdrawals.
- SC-02: no code path reads a patient fact for a non-care purpose without a `use-eligibility-v1` answer computed in the same transaction.
- SC-03: a withdrawal committed before an export's eligibility check excludes the patient; one committed after is ordered after the export and is visible in the export's evidence.
