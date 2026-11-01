# Medication follow-ups after capture

Date: 2026-11-01. Capture backend #244 and compact/type-ahead UI #245 are merged. This plan prepares their follow-ups; it grants no redistribution right, clinical sign-off or live deployment authority.

| Track | Accountable owner | Deliverable | Completion condition |
| --- | --- | --- | --- |
| List upkeep | Repository maintainer (`jzayas03`) | [Monthly procedure](../../ops/medication-list-maintenance.md) and review record | Each scheduled review records an update PR or a no-change result; source evidence and compatibility checks retained |
| ECRI/ISMP rights | Founder or counsel | Written permission request below and response reference | Written scope covers the intended use; licence/attribution and FDA conflict policy reviewed before any ISMP-only data enters a PR |
| Synthetic staging | Founder as release approver; maintainer prepares evidence | [Capture release plan](medication-capture-staging.md) | Founder reads the concrete plan and explicitly authorizes the target/release; live checks and signed artifacts then establish readiness |
| Drug–gene flags | Product owner plus a named pharmacist/clinical signer, still to be appointed | [Draft spec 031](../../../specs/031-medication-gene-flags/spec.md) | Product decisions, source rights, independent validation and clinical sign-off precede implementation/release of clinical output |

## Permission request

**Status: drafted, not sent; rights remain unconfirmed.** Spec 029 assigns the contact to the founder or counsel. Verify the current ECRI/ISMP rights or licensing contact on the official website before sending; no recipient address has been verified in this session. No ISMP-only rows are copied here.

Subject: Written permission to display ISMP Tall Man drug-name forms in Telesphoros

> Hello ECRI/ISMP permissions team,
>
> Cuadrado Zayas Infrastructure LLC is developing Telesphoros, a pharmacogenomics software product. We would like written permission to include the applicable ISMP Tall Man drug-name forms in a bundled, versioned ingredient-name lookup and display them in the product's medication picker and recorded-medication list. The product may be offered commercially. The software repository is public, so please distinguish permission for product display/distribution from permission to include the source data in a public repository and its compiled browser assets.
>
> We currently use FDA-listed forms only. We would retain RxNorm ingredient identifiers and canonical names for storage and matching; Tall Man capitalization would be a display convention, with plain accessible names for screen readers. We would not imply that ISMP/ECRI endorses the product or that displaying a name establishes clinical safety.
>
> Please confirm the specific list/version covered; permitted copying, redistribution and commercial use; whether browser-bundled/public-source distribution is allowed; required attribution, notices and links; any limits on adapting the data to an ingredient-only subset and providing accessible plain names; update obligations, fees, term, revocation and replacement requirements. If FDA and ISMP forms differ, please advise on any required presentation policy. If you are not the right contact, please direct us to the rights holder.
>
> We will not include ISMP-only entries until the permission and its conditions have been reviewed. We can supply a product example or further details through an appropriate channel.
>
> Thank you,
> Founder / authorized representative, Cuadrado Zayas Infrastructure LLC

After a reply, founder/counsel records the approved scope and restricted correspondence reference. The maintainer proposes an independently cited data update and tests. If permission excludes public-source/browser redistribution, keep ISMP-only content out of this repository and revisit the distribution design separately. No response is not permission.

## Decisions that remain with people

The maintainer assignment is operational ownership, not a declaration of medical authority. A clinical signer still needs to be named. The founder/counsel sends and accepts the rights request. A release approver must read the staging plan and authorize live actions. These decisions are not completed by opening tracking issues or by a successful software test.
