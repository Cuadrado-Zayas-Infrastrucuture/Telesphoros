# Spec 025 PD-a: patient demographics, encrypted identity and coded analytic fields (local)

Date: 2026-10-30

**What it adds.**
- `POST /api/v1/patients/:id/demographics` records or corrects a patient's given name, family name, date of birth, sex and ethnicity; `GET` reads the current version, or an earlier one with `?version=N`. Migration 0064.
- Patient lists gain the coded fields `sex`, `birthYear`, `ageYears` (from the birth year, so it can be one year high), `ethnicity` and `demographicsComplete`.

**What it guarantees, and where.**
- **Identity is never stored in plaintext.** Each patient gets a data key, wrapped by AWS KMS with the context `{tenant, patient}`; each identity field is AES-256-GCM, bound to its tenant, patient, field and key version. Names are padded to one fixed size, so length does not leak.
- **Lists never decrypt.** Only one patient's read, by a clinical read role, decrypts identity.
- **Nothing in logs, errors, security events or backups.** A test seeds recognizable synthetic values and searches every table, the captured logs, error bodies and security events for them.
- **Corrections append.** Each correction is a new ledgered version; the ledger holds ciphertext digests only.
- **Coded fields are fixed vocabularies.** Sex is `male` or `female`; ethnicity uses the 2024 federal list; empty means "not collected", never a guessed value.
- **Production needs the KMS key.** The API refuses to start in production without `PATIENT_FIELD_KMS_KEY_ID` (set by PD-b, PR #198) and refuses the local wrapping key there.

**What it does not do.**
- No collection screens yet (slice PD-c). No release to the analytics product (spec 020 E3 and D07, after counsel).
- Erasure by key destruction exists for tests only; it is not exposed until counsel answers the retention question, and it leaves no trace event yet.

**Rollout.** Ships in one release: the stage C apply that brings PD-b (the API task's key id and the context-bound KMS policy) and an image built from the merged `main`. The API refuses to start without the key id, so the image never runs before the apply. The ledger verifier ships in the same image and reads the new record.

Evidence: `docs/verification/patient-demographics.md`.
