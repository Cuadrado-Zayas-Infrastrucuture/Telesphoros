# M2.1b: patient identifiers and a verified report link (design note)

Status: **building on a local branch** (`claude/m2-1b-patient-identifiers-link`, stacked on M2.1a). This note refines the M2.1b section of the [M2.1 plan](m2-1-onboarding-patient-identity.md), whose decisions **DP-4** (identifiers as per-organization keyed digests) and **DP-5** (who may verify a link; evaluation refused until verified) the founder answered yes to on 2026-10-13. It adds what that plan left open: the **key-custody note** the plan said was needed first, the exact records, and the places the rule is enforced. Where this note differs from the plan, the difference is listed under [Differences from the plan](#differences-from-the-plan) so the founder can overrule it. Synthetic data only; nothing is applied in AWS.

## What this slice does

1. **Identifiers.** A clinician can attach to a patient one or more identifiers the clinic already uses (for example a medical record number), each under a short code for its assigning authority (`system`, such as `hospital-a-mrn`). The application stores only a keyed digest of the value, never the value, and never shows it back.
2. **A verified link.** A report names a patient only because someone chose that patient when registering it. This slice adds a recorded, second-person decision that **this report's exact file version belongs to this patient**, either by matching an identifier the person read off the report against the patient's registered identifiers, or by a coded, weaker attestation when no identifier can be matched.
3. **A gate.** An evaluation of a lab report is refused (`409 patient-link-unverified`) unless the report's *current* file version has a latest decision of `verified`. Replacing the file makes the report unverified again, because the decision names the file version it was about.

Not in this slice: wrong-chart quarantine, merge and unmerge of duplicate patients (M2.1c); reading identifiers out of the report text (task T10); any screen; real patient data.

## Key custody (the note the plan required)

**What is protected.** A medical record number is low-entropy: anyone holding the stored digests *and* the key could confirm a guessed number. So the digest is treated as sensitive: row-level security, never logged, never in an event, never in a response. The key is what turns a leaked table into something that cannot be matched.

**Derivation.** One 256-bit master secret, `IDENTIFIER_DIGEST_KEY` (64 hex characters; a Secrets Manager secret injected into the API task, the same pattern as `INVITATION_DIGEST_KEY`; required in production; a fixed non-secret key in development and tests). The key for an organization is derived, not stored:

```
orgKey = HKDF-SHA-256(ikm = master, salt = "telesphoros/patient-identifier/v1", info = "org:" + tenantId, length = 32)
digest = HMAC-SHA-256(orgKey, system + 0x00 + normalizedValue)
```

So the same number in two organizations (or under two systems in one) never produces the same stored value, no per-organization secret has to be created when a clinic is onboarded, and nothing in the database can be matched across organizations. The value is normalized by trimming, collapsing runs of white space and upper-casing (Unicode NFKC first). **No punctuation is removed**: matching is exact, because a false match here verifies a report against the wrong person.

**Versioning and rotation.** Each row stores `key_version` (1 today). Raw values are not kept, so *changing the master orphans existing identifiers*: they can never match again and must be re-entered. That is the price of not storing the value, and it is why the master is **not rotated on a schedule**. The procedure (an operations matter, not built here): add the new master as version 2 alongside version 1 in the task environment, have the application compute the digest under every configured version when matching and register new identifiers under the newest, and retire a version only after its identifiers have been re-entered. This slice builds the column and a single key; accepting several keys is a later, small change.

**Loss and exposure.** Losing the key makes every identifier unmatchable (a verifier must fall back to the weaker `person-confirmed` method until identifiers are re-entered; nothing else breaks). Exposure of the key together with the table allows guessing of low-entropy numbers for the organizations in that table; rotate by the procedure above and treat as an incident. The key is never printed, never in Terraform state, never in a log; the service refuses to start in production without it.

## Records

### `patient_identifiers` (mutable only to withdraw)

`id`, `seq`, `tenant_id`, `patient_id`, `system`, `value_digest` (32 bytes), `key_version`, `status` (`active`, `withdrawn`), `created_by`, `created_at`, `withdrawn_by`, `withdrawn_at`. A foreign key ties it to a patient of the same organization. **At most one active row per (organization, system, digest)**: one number identifies one patient at a time; a second patient claiming it is refused (`409 identifier-in-use`) and is the duplicate case M2.1c will handle. A withdrawn identifier stays as history and frees the number (for a number entered on the wrong patient). The application login may select and insert, and may update only the withdrawal columns; a trigger allows only `active` to `withdrawn`, once, by a named person.

### `report_patient_decisions` (append-only, one ledger event each)

`id`, `seq`, `tenant_id`, `created_by`, `created_at`, `ledger_event_id`, `report_id`, `patient_id`, `report_sha256`, `object_version` (the exact file version the decision is about), `decision` (`verified`, `rejected`), `method` (`identifier-match`, `person-confirmed`), `basis_code`, `identifier_id`.

- `identifier-match`: only `verified`; `identifier_id` names the registered identifier that matched; no `basis_code`. The typed value is digested on arrival and is in no row.
- `person-confirmed`: `basis_code` is required, from a frozen list. To verify: `no-identifier-on-report`, `identifier-not-registered`, `documented-clinic-procedure`. To reject: `different-person`, `identifier-conflict`, `cannot-establish`.
- The database refuses a decision unless the report is uploaded, its current hash and object version equal the ones the decision names, and its patient is the one named; and unless the deciding person is **none of** the report's creator, the person who asked for its first upload link, or the person who completed the upload. A person with only the `admin` role cannot reach the route at all.
- The *current* state of a report's link is derived, never stored: the newest decision for the report, if it names the report's current file version and patient; otherwise `unverified`. A later `verified` after a `rejected` is allowed (a second look); history is never edited.
- Each decision is a ledger record (event type `patient-link-decision`, in the organization's hash chain, covered by the verifier, the backup and the restore check).

## Routes

| Route | Roles | Does |
| --- | --- | --- |
| `POST /api/v1/patients/:id/identifiers` `{system, value}` | `clinician` | Registers an identifier. `409 identifier-in-use` if an active one already holds it |
| `GET /api/v1/patients/:id/identifiers` | clinical read | Lists `{id, system, status, createdAt, withdrawnAt}`. Never the value or the digest |
| `DELETE /api/v1/patients/:id/identifiers/:identifierId` | `clinician` | Withdraws it (`204`) |
| `GET /api/v1/reports/:id/patient-link` | clinical read, pipeline on | The current state: `unverified`, `verified` or `rejected`, the latest decision, and whether an earlier decision no longer applies because the file changed |
| `POST /api/v1/reports/:id/patient-link/decisions` | `clinician`, `reviewer`, pipeline on | Records a decision (bodies above). `identifier-match` that does not match answers `409 identifier-mismatch` and **writes nothing** |

`POST /reports/:id/evaluations` gains `409 patient-link-unverified`, checked before the reader runs and checked again inside the storing transaction (after the ledger lock), so a link that changes between the two cannot produce an evaluation.

## Where each rule is enforced

| Rule | Enforced in |
| --- | --- |
| No raw identifier stored | The only column that holds it is a 32-byte digest; a privacy test scans every table, the ledger, security events, logs and responses |
| One active holder per number | Partial unique index |
| Independence of the deciding person | Trigger on the decision table; the service gives the clear answer first |
| Decision names the current file and patient | Trigger on the decision table (with the report row locked in the writing transaction) |
| Append-only, one ledger event each | Existing record machinery (triggers, deferred event check) |
| **Evaluation requires a verified current link** | **The evaluation service, plus a re-check inside the storing transaction.** Not a table trigger: about fifteen existing database specs and recovery fixtures write evaluations directly with the owner connection, and the ledger fixtures cannot add a decision without a chain event. A test enforces that `insertEvaluation` is called from nowhere but the service in production source. The M2.3 worker must create evaluations through the same service |

## Differences from the plan

- A withdrawn identifier does not block its number forever: uniqueness is over *active* rows (the plan said unique on organization, system and digest outright). Needed so a number typed onto the wrong patient can be corrected.
- The link is not created `unverified` as a stored row at registration. "Unverified" is the absence of a decision for the current file version; this avoids a mutable status and a write on every registration.
- Per-organization keys are derived from one master (the plan said "a per-organization key held outside the database" without saying how many secrets). No secret per organization to create or lose at onboarding.
- A mismatching `identifier-match` writes no record and answers 409; the plan did not say what a mismatch records.
- The evaluation gate is in the service and its transaction, not in a trigger (see above).
- Rejecting a link here only records and blocks evaluation; quarantining existing evaluations of the report and requiring corrections is M2.1c.

## Verification plan

Each rule has a refusal test and a control that succeeds, and an injected defect that must fail a test: the same identifier in two organizations is two different stored values and never matches across them; a match verifies, a mismatch and a withdrawn identifier do not; the creator, requester and uploader of the report cannot decide, nor can an `admin` alone; evaluation is refused until verified and allowed after; a replaced file un-verifies; two people deciding at once leave a consistent history; the decision is in the ledger and the verifier, backup and restore check cover it; a privacy scan finds no raw identifier anywhere; the existing evaluation suites gain the verification step by hand. Then the three test tiers, the unprivileged recovery suites, the browser tier, typecheck, lint, build and the infrastructure guards.

## What this does not touch

Cognito, real patient data, the BAA, the report reader, extraction from report text, any screen, wrong-chart quarantine and merge (M2.1c), billing.
