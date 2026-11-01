# Tasks: Patient medications

Built in two slices, each its own branch and PR off a fresh `main`. Migration numbers are read at build time and again right before each push. The licence items in `spec.md` are read at source and recorded before MD-a merges.

## MD-a: the record and the list (backend)

| # | Task | Requirement |
| --- | --- | --- |
| T401 | Read at source and record: CPIC's terms for its RxNorm keys; ISMP or ECRI's written answer on Tall Man redistribution (founder asks); keep the NLM attribution text | MD-1, MD-8 |
| T402 | The versioned drug list file (CPIC drugs), its schema and a test: RxCUI present and unique, RxNorm release present, name is the RxNorm-normalized form | MD-1, MD-2 |
| T403 | `patient_medications` (append-only, ledgered, FORCE RLS, CHECKed vocabularies, year-month dates with stop not before start); run guards as the non-superuser migrator | MD-3, MD-4 |
| T404 | API: add, stop and correct (request id replay), current and `?version=N` reads; strict shared-types schemas; writer roles write, clinical read roles read | MD-4 |
| T405 | A seeded recognizable entry found in no log line, error body or security event | MD-5 |
| T406 | A test that the engine, interpreter and verifier do not import the medication module; no route combines a medication with a result | MD-6 |
| T407 | `tallMan` shared function with the FDA entries; tests: a listed name renders its Tall Man form, search ignores case, a stored record holds the canonical name | MD-8 |
| T408 | Full local loop, mutations (see plan), gitleaks | V |

## MD-b: the Medications section (frontend)

| # | Task | Requirement |
| --- | --- | --- |
| T501 | Medications section on the patient page: active first, then stopped, with source and dates | MD-7 |
| T502 | Coded drug picker (filter by typing, Tall Man shown, plain name as the accessible name); add, stop, correct | MD-7, MD-8 |
| T503 | Browser test in `storage-e2e` (it needs the database), axe in light and dark | V |
| T504 | Screenshots at 390, 768 and 1280 px, light and dark, sent to the founder before commit | V |

## Local MD-a progress, 2026-11-01

T401 records the founder-held CPIC licensing confirmation; FDA/NLM sources were re-read and ISMP-only entries stay excluded. T403–T407 are implemented locally with API, storage, access, privacy and clinical-boundary checks. T402 remains blocked by source access: the manifest explicitly records that no verified list is installed. A blocking shared-types test keeps that state red even though the API correctly refuses capture with 503. T408 has run the local loop and targeted defect probes, with full-tier failures/rechecks and environment limits recorded in [verification](../../docs/verification/patient-medications.md). No push, merge, deployment or AWS change.

## Subsequent delivery, 2026-11-01

The source-list blocker above was resolved in the recovery; MD-a and the independent fixture repair merged in PR #244. MD-b implements T501–T502, including compact searchable rows revised for 20 medications. T503 has real storage-backed mobile/desktop and light/dark accessibility coverage; T504's six 390/768/1280 light/dark previews were delivered in chat before commit. Current UI evidence and remaining profile limits are recorded in [MD-b verification](../../docs/verification/patient-medications-ui.md).
