# Telesphoros Remastered

CPIC-guided pharmacogenomic (PGx) decision support at the point of care.
Cuadrado Zayas Infrastructure LLC, San Juan, PR.

> **Clinical disclaimer.** This is a clinical decision *support* service. It
> does not prescribe, dispense, or replace clinician judgment. Recommendations derive
> from versioned CPIC guidelines in `knowledge/`; any model output is grounded in
> those rules and disabled until clinical sign-off.

**Status:** under construction, **synthetic data only**. Nothing has been applied in AWS and the AWS BAA is not executed, so no real
patient data may enter the system. The reader and the engine that run the lab-report pipeline are test-only and nothing here is approved
for clinical use. What is built, what is in flight and what is waiting on a person: [docs/STATUS.md](docs/STATUS.md).
How the pieces fit together: [docs/architecture.md](docs/architecture.md).

## Layout
| Path | Purpose |
| --- | --- |
| `apps/frontend` | Clinician-facing UI (Vite, React, Tailwind) |
| `apps/backend` | NestJS API: tenancy, authentication, reports and uploads, the lab-report pipeline, the records and audit ledger, the phenotype and recommendation engines, backup and restore |
| `apps/ai-service` | Model serving, retrieval, prompts, grounding evaluators (not started) |
| `packages/` | `shared-types` (API contracts), `cpic-schema` (knowledge and engine schemas), `fake-idp` (test identity provider), `fhir-utils` (placeholder) |
| `knowledge/` | Version-controlled clinical knowledge: `cpic/` (the real, reviewed content; empty until sign-off), `lab-report-reader/` (a byte-identical, **test-only** import of the reader engine) |
| `sidecars/report-reader` | The Python wrapper that runs the imported reader engine |
| `tests/` | Hand-written expected results (`report_adapter`, `report_reader`, `clinical_scenarios`), backup fixtures, end-to-end |
| `ml/` | Model training, evaluation, model cards (not started) |
| `data/` | **Synthetic data only**, including the test-only knowledge the adapter tests use |
| `infrastructure/` | Terraform (written, never applied) and its security tripwire test |
| `docs/` | Architecture, status, design specifications, operations runbooks |

## Working on it
- Install: `pnpm install` (pnpm 10.28; Node is pinned to an exact release in CI, see [docs/ops/ci-cd.md](docs/ops/ci-cd.md)).
- Checks that every pull request must pass: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, `pnpm test:infra`, `pnpm test:ci-config`.
- The backend has **three test tiers**: in-memory (no services), PostgreSQL (`TEST_DATABASE_URL`, start one with
  `apps/backend/scripts/dev-postgres.sh start`), and PostgreSQL plus an S3 emulator (`TEST_S3_ENDPOINT`). CI runs all three; see
  [docs/database.md](docs/database.md) and [apps/backend/README.md](apps/backend/README.md).
- How we work, and the rules that are not negotiable: [CONTRIBUTING.md](CONTRIBUTING.md) and the working agreements in [docs/STATUS.md](docs/STATUS.md).

## Data rules
No real PHI in git, `data/`, or `ml/`. Training data is synthetic or de-identified only. No secret is ever committed or printed.
