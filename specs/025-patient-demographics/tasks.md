# Tasks: Patient demographics

Built in slices, each its own branch and PR off a fresh `main`, after the founder approves D1 to D9. Migration numbers are read at build time and again right before each push.

## PD-a: key handling and the record (backend)

| # | Task | Requirement |
| --- | --- | --- |
| T101 | `patient_field_keys` (wrapped data key per patient, key version) and `patient_demographics` (append-only, ledgered, FORCE RLS; identity ciphertext columns, coded analytic columns with CHECKed vocabularies, birth year tied to date of birth) | PD-2, PD-4, PD-5 |
| T102 | A key provider: KMS envelope in deployed builds, a local provider refused in production; AES-256-GCM with associated data (tenant, patient, field, key version) | PD-2, PD-3 |
| T103 | API: create and correct demographics; detail read decrypts for clinical read roles only; lists return coded fields and age only; strict shared-types schemas | PD-5, PD-6 |
| T104 | No plaintext anywhere: logs, error bodies, security events, backups (a seeded-value search test) | PD-1 |
| T105 | Erasure by key destruction, test-only on staging | PD-8 |
| T106 | Full local loop, mutations (associated data dropped, context not enforced, a list that decrypts, a value in an error), gitleaks | V |

## PD-b: infrastructure (staging)

| # | Task | Requirement |
| --- | --- | --- |
| T201 | IAM: the API role's `kms:GenerateDataKey` and `kms:Decrypt` on the `data` key with an encryption-context condition; a plan reviewed with the founder before any apply | PD-3 |

## PD-c: collection in the interface (frontend)

| # | Task | Requirement |
| --- | --- | --- |
| T301 | "Add patient" asks every field with coded pickers: sex is male or female, ethnicity uses the D3 list; either may be left empty | PD-7 |
| T302 | "Incomplete" as a word in color and a one-line prompt when a report is attached; never blocking | PD-7 |
| T303 | The patient's page: current values and version history; corrections | PD-5 |
| T304 | Completeness counts per tenant, each with its denominator | PD-7 |
| T305 | Screenshots at 390, 768 and 1280 px, light and dark, sent to the founder before commit | V |
