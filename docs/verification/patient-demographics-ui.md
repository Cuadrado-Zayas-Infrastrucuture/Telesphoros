# Verification: patient demographics in the web app (spec 025 PD-c)

Date: 2026-10-31. Branch `feat/patient-demographics-ui`, off `main` `0c392de2`. Frontend only: no backend, migration or infrastructure change. Synthetic data only; nothing is published to staging.

Every number below comes from a command run on this branch's final code. The full local loop replays each step of `.github/workflows/ci.yml` that can run on this machine.

## Unit and component tests

| Check | Result |
| --- | --- |
| Frontend tests (vitest, 55 files, after merging `main` `31a624b2`) | 625 passed, 0 failed |
| New tests | `demographicsDraft` and `patientDemographics` (API helpers, fixed-text errors), `PatientPage` (8), panel "with demographics" (5), Upload (2) |
| Typecheck, lint | pass |
| Build, `check:chunks` | pass: 126 components, every page chunk checked; entry chunk 95.5 kB gzip against the 150 kB budget |

## Browser tests

| Suite | Result |
| --- | --- |
| `e2e` (default, in-memory backend; merged tree) | 207 passed, 5 skipped, 0 failed |
| `e2e` local config | 46 passed |
| `e2e` owned-local config | 2 passed |
| `e2e:storage` (PostgreSQL, owned storage) | 35 passed, 0 failed, including the PD-c test in both viewports |

The PD-c browser test is in `storage-e2e/patient-demographics.spec.ts`, not in the default suite: the default backend is in-memory and has no demographics by design (ledger guarantees are database guarantees), so saving returns "cannot be saved right now". The storage suite's backend gets a synthetic in-process key (`PATIENT_FIELD_LOCAL_KEY`, built in code so no literal sits in the repository).

What the test proves: a clinician adds a patient with demographics in the panel; the row is not marked Incomplete; the patient page shows the values and "Complete"; the address and page title hold no name; a correction adds version 2 and an earlier version opens by its number; the page has no WCAG A/AA violation; a reviewer in the same organization reads it and is offered no correction; a reader in another organization gets "This patient is not available." and no name; a patient added with a label alone shows Incomplete.

## Screenshots

30 states (patient page, correction form, no demographics yet, Add patient panel, Incomplete word, each at 390, 768 and 1280 px, in light and dark) were captured and read, and axe (WCAG 2.0 and 2.1 A and AA, colour contrast included) reported 0 violations in all 30. Looking at them found one defect, fixed before this commit: the patient page title sat on a darker band, because the workspace stylesheet paints every `<header>` as page frame (`.workspace-shell header`); the title now uses a plain `div`.

## After merging `main`

`main` moved from `0c392de2` to `31a624b2` (usage calendar, staging status, a picker fix) and changed four files this branch also changes. The merge was clean, but one of my tests failed on it (its helper now renders inside a router; I had added a second one): fixed in its own commit. The frontend, e2e, storage and guard numbers above are from the merged tree. The backend tiers were not rerun on it: this change touches no backend file, and the hosted run replays them.

## Failures the loop found, all fixed

| Found by | Cause | Fix |
| --- | --- | --- |
| `check:chunks` | the repository allows one component per file; the page held four | split into the page plus five component files |
| e2e (45 specs) | "(Incomplete)" added to Upload's option names broke every helper that finds a patient by exact name | options keep the plain label; the Incomplete line under the picker carries the signal |
| e2e touch targets | sidebar patient links were 16 px tall against the 44 px minimum | `min-h-control` on the link |
| e2e (PD-c test) | demographics need the database; the default backend answered 503 | moved to the storage suite, with its own synthetic key |
| e2e (PD-c test) | a page reload inside the test ended the in-memory session | navigate by the page's own link |
| screenshots | title band, see above | `div` for `header` |

## Mutation checks

Six deliberate breaks, each caught by a failing frontend test, then the files restored and their sha256 compared (6 of 6 caught):

- completeness reads true when only sex is recorded;
- a retry sends a new request id;
- the Incomplete word is not shown;
- Enter on the Upload fields does not add the patient;
- a 404 for a requested version reads as "none";
- blank optional fields are sent as values.

## Backend, worker and repository guards (unchanged code, run for the loop)

| Step | Result |
| --- | --- |
| Backend tier 1 | 3304 passed, 1 failed: `stored-pgx-preview` "does not fall back when a new current evaluation is retracted" exceeded its 30 s limit while the loop ran other work. Run alone it passes 8/8, and it passed in tiers 2 and 3. Cause unproven; this change touches no backend file |
| Backend tier 2 (`TEST_STORAGE=postgres`) | 3920 passed, 21 skipped, 0 failed |
| Backend tier 3 (postgres and S3) | 3940 passed, 1 skipped, 0 failed |
| Worker | 246 passed |
| `test:infra` | 177 passed (merged tree) |
| `test:ci-config` | 214 passed (merged tree) |
| gitleaks | no leaks found |
| Docker build and rehearsal | both pass |
| `test:fixture-lifecycle` | 9 passed, 2 failed (subtests 6 and 8): the known failure on this Mac, hosted CI green, cause unproven (memory `fixture-lifecycle-red-locally`) |
| FHIR IG validator | not run: no Java 21 on this machine |

## Not covered

- Completeness counts per organization (T304): a backend route, a separate change.
- The chat's inline patient creation takes a label only; that patient starts Incomplete.
- The hosted CI run: this change is local until the founder says to push.
