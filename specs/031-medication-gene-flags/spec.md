# Draft specification: medication–gene review flags

Created: 2026-11-01. **Draft; not approved for implementation or clinical use.** Product owner: repository maintainer. Required pharmacist/clinical signer: not yet appointed.

## Problem and boundary

Medication capture (spec 029) records what was entered, not a drug–gene interpretation. A future clinician may need to know whether a current medication has a source-supported finding in an accepted patient result. That is clinical decision support and remains under the clinical hold. This document does not authorize changing MD-6's no-combination guard, loading production knowledge, adding a route or showing a flag.

## Proposed decisions for approval

| Decision | Proposed scope | Approval evidence still needed |
| --- | --- | --- |
| First output | Passive, per-medication "Review" or "Held" with an on-demand evidence explanation; no prescribing, dosing, replacement drug or interruption | Product/clinical owner approves wording and intended use |
| Drug match | Exact, reviewed RxNorm ingredient identifier; no brand-name guessing, fuzzy clinical match or inference from typed suggestions | Versioned drug/guideline mapping and source rights |
| Patient evidence | Accepted, current, correctly linked result/capture and medication versions in the same tenant; consent/use restrictions respected | Named eligible result contract, stale/conflicting evidence policy and authorization review |
| Clinical oracle | Versioned, licensed, independently reviewed and hash-bound CPIC content using the existing knowledge/sign-off contract | Named pharmacist signer, verified cells, supported population/gene combinations and independent source fixtures |
| Missing evidence | Explicit hold/unavailable state; never infer "safe", "no interaction" or "normal" from an absent match | Clinical review of every hold reason and negative control |
| UI | Compact row text; evidence/details on demand; verify 20 medications, keyboard, mobile and light/dark | Visual review and accessibility evidence |

## Requirements for a future approved implementation

1. Bind each answer to tenant, patient, medication entry/version, result/capture/acceptance version, source-list version, guideline/cell content hash and evaluation time. Patient merges, new corrections, withdrawals, disputes or superseding evidence invalidate prior eligibility; no stale answer becomes current silently.
2. Reuse the existing deterministic knowledge/engine validation and role model. Handle required multi-gene/population context explicitly; unsupported alleles, contradictory results, missing source rights or unverified cells end in a hold. Source labels or CPIC's drug catalogue alone are not clinical evidence.
3. Define the approved signed-knowledge RxCUI mapping contract first; the current guideline schema uses names and must not be joined by case-insensitive name as a shortcut. Any schema evolution has its own migration/compatibility review if needed.
4. Refuse unknown/foreign patients and prohibited result/medication joins, including role loss and cross-tenant identifiers. Return fixed errors; no medication, genotype, phenotype or patient value in logs, security events or diagnostic URLs.
5. Keep immutable prior evidence readable where authorized. A flag cannot overwrite a medication fact, accepted capture, result or recommendation. No analytic release or external terminology/model call is implied.
6. Document and review how MD-6 is deliberately superseded in this separate approved scope. Preserve existing capture-only behavior until that approval and an independently tested gate exist; never remove its guard just to make the future join pass.

## Validation and release gates

Before code: named clinical signer, approved intended use/decisions, source rights, signed-content and RxCUI mapping design, independently sourced synthetic fixtures and a clinical-validation plan. Before any clinical output: positive source cases and holds for missing/unreviewed/contradictory/stale/multi-gene evidence; tenant/role/replay/concurrency controls; source and hold mutation checks; compact 20-entry UI, keyboard and light/dark axe; real PostgreSQL/S3/ledger checks; all required CI; documented clinical sign-off and separately authorized release. Software CI alone never closes a clinical sign-off gate.

No knowledge content, flags, endpoint, schema, model or clinical activation is included in this draft.
