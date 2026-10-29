# Verification: result acknowledgements (spec 019, D02a)

Date: 2026-10-29. Branch `feat/result-acknowledgements`, built and verified on `main` `73efc16`. Local only, not pushed. Plan: spec 019 `plan.md` and `tasks.md`, approved by the founder on 2026-10-29 (P2 to P7 as recommended; a sibling `GET`).

**What was claimed:**
- `POST` and `GET /api/v1/evaluation-results/:id/acknowledgements`.
- A new append-only, ledgered record `result_acknowledgements` (migration 0060, event type `result-acknowledgement`).
- Clinician-only by the live membership row; reading for the clinical read roles.
- The basis shown is compared with the server's after the ledger lock (409 `acknowledgement-basis-changed`).
- Retries are idempotent through a required `requestId`; one acknowledgement per clinician, result, review task and kind (409 `already-acknowledged`).
- A `ReviewedControl` component and a test-only page mounted in the e2e build alone.

**Environment:** macOS, Node 22.22.0, pnpm 10.28.0, PostgreSQL 16 (own cluster, locale en_US.UTF-8), Moto on its own port, the Playwright Chromium build. The report-reader engine is absent, as in every public checkout.

## Tests (synthetic fixtures; the oracle is the database, read as the administrator, or the database's own refusal)

- `apps/backend/test/result-acknowledgements.e2e-spec.ts`: **15**, over HTTP. Binding (wrong patient, a body naming another result); roles (reader, reviewer and admin 403 on `POST`; admin 403 on `GET`); tenancy (another tenant's clinician or reader 404 on both routes); a dropped clinician role refused although the token still claims it; validation; A5; the ledger verify; no response field says anything was read, seen, ordered, dispensed or taken. The plan's scenarios 1, 2, 4 and 5 are tests here.
- `apps/backend/test/db/result-acknowledgements.pg-spec.ts`: **14**, direct SQL as the application role: the composite key, the trigger's actor binding and live clinician check (`RA001`), the A3 kind/basis CHECK, the task CHECK, the A5 key in one transaction, append-only, and the database's basis list equal to the shared list. **Under real lock interleaving:** a dispute committed first makes the next review refuse after the lock; a review holding the ledger lock commits and a dispute queued behind it commits after, and the review then reads as made in the earlier basis.
- `apps/frontend/src/components/acknowledgements/ReviewedControl.test.tsx`: **13**. Every state of the control, with axe clean in each; scenario 2 (409, then only "Retraction reviewed"); scenario 3 (a patient or result change abandons a pending review, and nothing submits or shows against the previous one); scenario 4 (a lost answer retries the same request); the test-only page lists ids only, axe clean.
- `apps/frontend/src/app/testOnlyRoutes.test.ts` and `scripts/check-chunks.mjs`: the production build has no chunk and no route path for the test page. Negative control: run on an e2e-mode build, the check fails with both findings.
- Inventories updated: schema acceptance, tenant binding (policies 55 to 57), tenant capability, down guards (a populated table is refused **as the non-superuser migrator**), the gate route list, and the controller count (21 to 22).

## Mutation checks (scratch edit, run, then restored and sha256-matched)

| Mutation | Result |
| --- | --- |
| The basis comparison after the ledger append removed | caught: scenario 2 and the extra-category case answer 201 instead of 409 (rerun independently by the parent session: 2 failed, `expected 409, got 201`) |
| `@Roles('clinician')` removed from `POST` | caught: a reader on a missing result gets 404 instead of 403; the other refusals still hold because the trigger refuses them |
| The trigger's clinician check removed | caught: the database tests expect `RA001` and get the ledger or `author_roles` refusal instead |
| The A5 unique key removed | caught: 4 tests, a second row stored (201, or no `23505`) |
| The page's row key without the patient | caught: the abort assertion in the page test |

## Full local loop (on `73efc16` plus this change)

| Step | Result |
| --- | --- |
| build, typecheck, lint | pass |
| `pnpm test` (workspace) | pass |
| `test:ci-config` | 207 / 207 |
| worker | 241 / 241 |
| frontend | 518 / 518 |
| backend default / PostgreSQL / PostgreSQL+S3 | 3188 / 3572 / 3592 passed, 0 failed |
| Playwright `e2e` | 153, 30 and 2 passed |
| Playwright `e2e:storage` | 26 passed, 6 failed: the same six tests that fail on `73efc16` itself, fixed separately by PR #170 |
| gitleaks over the changed directories | no leaks |

**Rerun after merging `main` `5002d68`** (which includes PR #170): every step passed. Backend 3188 / 3573 / 3593 passed, 0 failed; frontend 524; worker 241; `test:ci-config` 207; Playwright `e2e` 155, 32 and 2; `e2e:storage` 33 passed, 0 failed; gitleaks no leaks.

## Not covered

- **No Playwright test drives the test-only page.** Its states and accessibility are covered in jsdom; a browser test needs seeded evaluation results in the e2e backend.
- **P6 care relationship.** No care-team model exists; the history is readable by the clinical read roles, tenant-scoped, as D01b's is.
