# Verification: patient demographics (spec 025, PD-a)

Date: 2026-10-30. Branch `feat/patient-demographics-core`: one commit off `main` `e02495ac` (PD-b merged), then `main` `85179042` merged in (#199 to #203). Plan: spec 025 `spec.md` and `tasks.md`, D1 to D9 (founder, 2026-10-30: name and date of birth encrypted per patient from day one; sex `male`/`female`; one ethnicity field from the 2024 federal list; empty means Incomplete).

**What was claimed:**
- Migration 0064: `patient_field_keys` (one data key per patient, wrapped by KMS with the context `{tenant, patient}`) and `patient_demographics` (ledgered versions, event type `patient-demographics`), both FORCE RLS.
- Given name, family name and date of birth are stored only as AES-256-GCM ciphertext with a fresh 96-bit nonce, bound to tenant, patient, field and key version; names are padded to one size (402 bytes), and the table's CHECK pins every ciphertext length.
- Patient lists carry the coded fields only and never decrypt; one patient's read by a clinical read role is the only decrypting path.
- No name, date of birth or ciphertext reaches a log line, an error body, a security event, the ledger or a backup dump.
- The API refuses to start in production without `PATIENT_FIELD_KMS_KEY_ID` and refuses the local wrapping key there.

**Environment:** macOS, Node 22.22.0, pnpm 10.28.0, PostgreSQL 16 (own cluster), Moto on its own port (S3 and KMS), the Playwright Chromium build. The report-reader engine is absent, as in every public checkout.

## Tests (synthetic fixtures; the oracle is the database, read as the administrator, or the database's own refusal)

- `identity-crypto.spec.ts`: round trip of every field; one ciphertext length for a one-letter name and the longest accepted name; a name too long to pad is refused; a fresh nonce on each of 200 calls; a ciphertext moved to another tenant, patient, field or key version does not decrypt, each with a positive control; any changed byte, another key or another nonce is refused with fixed text; the associated data differs for every component; the request fingerprint is keyed.
- `field-key-provider.spec.ts` and `test/object-storage/patient-field-kms.s3-spec.ts`: the KMS provider sends the `{tenant, patient}` context, and a key unwrapped under another context fails (against Moto's KMS).
- `test/db/patient-demographics.pg-spec.ts`: no plaintext in any stored row; version numbers in order, also under concurrent corrections; a version without its ledger event refused at COMMIT; one event per version with ciphertext digests only, and a ledger that goes red when a ciphertext is altered; every D3 code accepted, malformed rows refused (417- and 419-byte name ciphertexts among them, around the 418 the CHECK requires); no update, delete or truncate, even by a superuser; FORCE RLS and the per-role privileges; one key per patient; `patient_field_key_erase()` executable by no login, after which versions stay, none opens, and the ledger still verifies.
- `test/patient-demographics.e2e-spec.ts`, over HTTP: first version and corrections (version 1 stays readable), 404 before any version, another organization's patient treated as not found, the role matrix (clinician writes; reader and reviewer read; others get nothing), retry replay and 409 on a reused request id, client-sent birth year refused, list fields without identity and with a control that the detail read does decrypt, 503 when no data key can be made, 410 after erasure, and no route that exposes erasure.
- `test/patient-demographics-privacy.e2e-spec.ts`: seeds recognizable synthetic values, then searches every column of every table (as text, hex, base64 and percent-encoded), the captured log lines, every error body, the security events and access evidence, the ledger, and the backup command's plaintext dump. Each search has a control that proves it would see a planted value.
- `env.spec.ts`: production without the key id, or with the local key or a KMS endpoint, is refused at start.
- `down-guards-as-migrator.pg-spec.ts`: a populated table is refused by the down migration as the non-superuser migrator, with a positive control.
- Inventories updated: schema acceptance, tenant binding, tenant capability, the ledger catalog and the projections.
- `infrastructure/docker/rehearsal.cjs`: the rehearsal's production environment now names a key id; without it the image refuses to start.

## Mutation check (scratch edit, run, then restored and sha256-matched)

| Mutation | Result |
| --- | --- |
| Name padding removed from `sealField`/`openField` (plaintext encrypted at its own length) | caught: 8 tests failed; restored file sha256-matched, then 114 / 114 in the patient-demographics unit specs |

## Full local loop (`d480204c`; every local step of the CI `verify` job, listed from `.github/workflows/ci.yml`)

| Step | Result |
| --- | --- |
| typecheck, lint, build, `pnpm test` (workspace), `test:demo-seed`, `check:chunks`, `knowledge:verify --production`, shared-types build, `check:workflows` | pass |
| `test:ci-config` (includes the applied-status guard from #203) | 209 / 209 |
| `test:infra` | 161 / 161 |
| `check-without-reader.sh --measure --listed` | pass |
| `test:fixture-lifecycle` | 9 pass, 2 fail (tests 6 and 8): the same two fail on unchanged `main` on this machine; cause unproven, not caused by this change |
| worker | 241 / 241 |
| frontend | 563 / 563 |
| backend default / PostgreSQL | 3294 / 3909 passed, 0 failed (of 3930) |
| backend PostgreSQL+S3 | 3928 passed, 1 failed (of 3930): `report-registration.pg-spec.ts` "bounded migration lock contention" hit its 5 s timeout. The same spec passed in the two tiers above, and alone on the same tier three times (7 / 7 each). Cause unproven; the loop ran on a shared machine |
| Playwright `e2e` | 205 passed and 5 skipped, 46 passed, 2 passed |
| Playwright `e2e:storage` | 33 passed |
| gitleaks over the changed directories, and over the branch's commits | no leaks |
| Docker image rehearsal (`rehearsal.cjs` on a local linux/amd64 build of `api.Dockerfile`) | pass (7 checks, exit 0); with the key id removed from `rehearsal.cjs` it fails at the driver's initialize step (exit 1), so the env change is required |
| FHIR IG validation (`smart-pilot test:ig`) | not run: no Java 21 here; this change does not touch the SMART pilot |

After `main` `35d14799` (#204 frontend load path, with `sideEffects: false` on shared-types, and #205 docs) was merged in: no file is changed on both sides, and the lockfile is unchanged. Rerun on the merge: typecheck, lint, build and `check:chunks` pass; shared-types 121 / 121, frontend 570 / 570, `test:ci-config` 209 / 209.

## Not covered

- **Real AWS KMS.** The provider runs against Moto's KMS. The IAM condition that limits the API task to the `{tenant, patient}` context (PD-b, #198) is checked by the Terraform guard, not by a live call; it is first exercised by the staging release.
- **Erasure** is reachable from tests only, and it leaves no trace event yet.
- **`ageYears`** comes from the birth year, so it can be one year high.
- **Collection screens** (PD-c) and any release to the analytics product (spec 020 E3) are not part of this change.
