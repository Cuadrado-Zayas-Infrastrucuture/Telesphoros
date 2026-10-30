# Feature Specification: Patient demographics, encrypted identity, coded analytic fields (PD)

**Feature Branch**: `docs/spec-025-patient-demographics` (this spec); build branches follow its slices.

**Created**: 2026-10-30

**Status**: Approved 2026-10-30. D1 to D9 were accepted as recommended, with D3 as the founder set it ("male or female only, use ethnicity only"; one field on the 2024 list; empty means Incomplete). Building starts with slice PD-a, after spec 024. The founder's direction:
- "Name, sex, age, DOB, Race should be at least the minimum we write down."
- "This data should help us feed the other data analytics product, for PGx sex, age and race are important."
- "The UI interphase should facilitate data collection and feed our analytics."
- On protection: "Encrypted from day one."

**Input**: today a patient is only a synthetic label. `0001_core_tables.up.sql:25` says "No name, date of birth or real identifier". Clinic identifiers are stored as keyed digests, never values (`patient_identifiers`, 0020). This spec reverses the first rule on purpose, for synthetic data on staging, and sets how real values would be protected later.

## What exists today (read at `main` `4c76ca51`)

- **`patients`:** a legacy table (not ledgered; `LEGACY_TABLES`, `append-only-tables.ts:36`) with `id`, `tenant_id`, `label`, `created_by`, the creation request id and hash, and timestamps. FORCE RLS, `patients_tenant` policy. The API login has SELECT, INSERT and UPDATE; the worker login cannot read it (`provision-logins.ts:214`).
- **API:** `patients.controller.ts`. Create is clinician-only with request-id replay; label update; delete blocked while reports exist. `PatientDto` is a strict object built by an explicit mapper (`patients.mapper.ts`).
- **Keys:**
  - Identifier digests use HKDF-SHA-256 per organization from one master in Secrets Manager (`identifier-digest.ts`; `api-compute.tf:192-195`). Rotation is not built.
  - AES-256-GCM is already used in code, for session tokens and backups (`session-crypto.ts`, `backup-crypto.ts`).
  - KMS keys exist (`kms.tf`), but the API role's KMS rights work only through S3 (`iam.tf:33-37`). Field encryption needs a new IAM statement.
- **Logs:** the logger redacts only `authorization` and `cookie` and logs route templates, not bodies (`logger-options.ts`). Error `details` are returned to the caller (`all-exceptions.filter.ts:46-50`). Backups dump every public table (`backup.ts:145`).

## Decisions (approved 2026-10-30)

| # | Decision | Recommendation | Why |
| --- | --- | --- | --- |
| D1 | **Two kinds of field** | **Identity:** given name, family name, full date of birth. **Analytic attributes:** sex, birth year, ethnicity. They are kept in separate columns with separate rules. | Analytics needs the attributes, never the identity. HIPAA Safe Harbor removes names and every date element except the year. |
| D2 | **How identity is encrypted** | **Envelope encryption.** Each patient gets a random data key. KMS wraps it under the existing `data` key, with the encryption context `{tenant, patient}`. Each identity field is AES-256-GCM with its own nonce, bound by associated data to tenant, patient, field and key version. The wrapped key lives in `patient_field_keys`. | KMS never releases the master. Every unwrap is a CloudTrail record. A per-patient key allows erasure by destroying that one key (D8). The per-organization HKDF pattern has no rotation and cannot erase one patient. |
| D3 | **Analytic codes (founder, 2026-10-30: "male or female only, use ethnicity only")** | **Sex:** `male` or `female`, nothing else. **Birth year:** derived from the date of birth and stored as its own coded column; age bands are computed when read. **Ethnicity:** one field, the OMB SPD 15 (2024) combined categories, more than one allowed: `american-indian-or-alaska-native`, `asian`, `black-or-african-american`, `hispanic-or-latino`, `middle-eastern-or-north-african`, `native-hawaiian-or-pacific-islander`, `white`. There is no separate race field and no `unknown` or `declined` code. A field nobody has filled stays empty, and the patient shows "Incomplete" (founder's choice). All are CHECKed vocabularies, never free text. | Clean, comparable values for the analytics product. The 2024 standard is one combined question, so one field keeps the population groups PGx analytics needs. |
| D4 | **Ethnicity is not ancestry** | Ethnicity is demographics. The recommendation engine never reads it. Genetic ancestry, if wanted, is a separate later decision. | CPIC frequency tables use biogeographic groups; ethnicity is a social proxy. |
| D5 | **Records and corrections** | A new append-only `patient_demographics` record. A correction adds a version and never overwrites. It is **ledgered** (new event type `patient-demographics`), and the ledger payload holds the ciphertext digests, never plaintext. `patients` keeps its label as the display handle. | Demographics are part of the clinical record, so tamper evidence matters. Ciphertext digests keep plaintext out of the ledger. |
| D6 | **Who reads what** | The API decrypts identity only for clinical read roles, and only on a patient's own detail read: lists show the label, sex, birth year, age and ethnicity. The worker login cannot read either table. Analytics reads only the coded columns, only through `use_eligibility` (spec 020) and a de-identified release (D07). | Minimum necessary. Collecting for care is not permission for analytics (spec 020 E1). |
| D7 | **Never in logs or errors** | Request bodies stay unlogged. New validation errors name the field, never the value. A test sends recognizable values and asserts none appears in logs, error bodies or security events. Backups carry ciphertext only. | No PHI in logs, errors or third-party services. |
| D8 | **Erasure** | Destroying a patient's row in `patient_field_keys` makes their identity unreadable everywhere, backups included. The command is built, but staging keeps it test-only until counsel answers question 10 (retention). | Append-only records cannot be deleted; a destroyed key erases them. |
| D9 | **Collection in the interface** | "Add patient" asks every field: name, date of birth, sex (male or female) and ethnicity (the D3 list, more than one allowed). Sex and ethnicity may be left empty. A patient whose fields are missing shows "Incomplete" as a word in color, with a one-line prompt when a report is attached; sending is never blocked. The patient's page shows the version history. Each tenant sees completeness counts with their denominators ("142 of 160 with sex recorded"). | The interface does the data-quality work without blocking care. |

## Out of scope

- Releasing data to the analytics product (spec 020 E3 grants, D07 release; both wait for counsel).
- Genetic ancestry; real patients (a BAA and counsel first); matching duplicates on name and date of birth; FHIR Patient export.
- Changing the engine. Any production rollout.

## Requirements

- **PD-1** No identity value is stored, logged, returned in an error or written to a backup in plaintext. A test seeds recognizable values and searches the database, logs, error bodies, security events and a backup for them, finding none.
- **PD-2** Ciphertext is bound to its tenant, patient, field and key version. Moving a ciphertext to another patient or field fails to decrypt (a test).
- **PD-3** KMS unwraps require the encryption context `{tenant, patient}`. IAM allows the API role `kms:GenerateDataKey` and `kms:Decrypt` on the `data` key only with a matching context condition. Local and test runs use a local key provider that never runs in production (env refusal, like `IDENTIFIER_DIGEST_KEY`).
- **PD-4** At the database, sex is `male`, `female` or empty; ethnicity holds only the D3 codes, or is empty; any other value is refused. The birth year always equals the year of the date of birth.
- **PD-5** A correction adds a version, and the previous version stays readable to clinical read roles. The ledger verifies across versions.
- **PD-6** Lists never decrypt identity. A detail read by a non-clinical role gets no identity fields.
- **PD-7** The interface collects every field with coded pickers and shows "Incomplete" without blocking a report.
- **PD-8** Destroying a patient's field key makes every version unreadable, and the API answers "identity erased" for that patient.
