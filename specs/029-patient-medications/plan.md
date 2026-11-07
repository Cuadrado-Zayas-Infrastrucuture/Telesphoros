# Plan: Patient medications, data capture only

Follows `spec.md` (D1 to D10 approved 2026-11-01). Capture and display only: nothing here reads a genotype, a phenotype or a report.

## Approach

- **The record** copies spec 025's shape: `patient_medications` is append-only and ledgered, FORCE RLS, tenant-scoped; a row is one version of one entry (entry id, version, patient id, drug RxCUI, list version, status, start and stop as year-month, source, created by and at). Corrections add a version; nothing is updated in place. Coded columns have CHECKed vocabularies. Migration number read at build time, and again before each push.
- **The drug list** is a versioned JSON file in the repository (`packages/cpic-schema` or a new `packages/drug-list`; choose when MD-a starts by grepping which package already owns drug names, `drugNameSchema` is in `packages/cpic-schema/src/knowledge.ts:35`). Each entry: RxCUI (ingredient, TTY `IN` or `MIN`), the RxNorm-normalized name, `displayName` (Tall Man form where the FDA list has one, with list name and date), RxNorm release. A test refuses a missing or duplicate RxCUI, a missing release, or a name that is not the RxNorm-normalized form. The file carries the NLM attribution text; the product page that shows the list shows it too.
- **Tall Man** is one shared function (`tallMan(name)`, backend-free, in a shared package) used by every screen that shows a drug name. Display only: the record keeps the RxCUI and the canonical name; search ignores case; the plain name is the `aria-label`.
- **API** (strict shared-types schemas): `POST /api/v1/patients/:id/medications` (add, stop or correct = a new version, with a request id that replays safely, as in spec 025) and `GET` (current entries; `?version=N` per entry). Writer roles write; clinical read roles read; others get 403. No route combines a medication with any result (MD-6).
- **Privacy:** coded and plain under RLS, never in logs, error bodies or security events (MD-5): a seeded recognizable entry is searched for in all three.
- **Screen (MD-b):** a Medications section on the patient page beside Demographics, active entries first, then stopped; a coded picker (type to filter, Tall Man shown); add, stop, correct. Same quiet style: no badges, status as a word in color.

## What is not touched

Engine, interpreter, verifier, reports, evaluations (MD-6 asserts the medication module is not imported by them); demographics code except where the page hosts a second section; staging and infrastructure.

## Slices

MD-a (backend, one PR), then MD-b (frontend, one PR). The licence items in `spec.md` must be read at source and recorded before MD-a merges. No staging release without the founder reading a plan first.

## Verification

Full local loop replaying `.github/workflows/ci.yml`; mutation checks (a list entry without an RxCUI, Tall Man stored instead of the canonical name, a medication in a log line, a version overwritten in place, a route that joins a result); gitleaks; the record read as the non-superuser migrator under FORCE RLS.
