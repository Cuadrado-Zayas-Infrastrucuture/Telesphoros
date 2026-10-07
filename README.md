# Telesphoros Remastered

CPIC-guided pharmacogenomic (PGx) decision support at the point of care.
Cuadrado Zayas Infrastructure LLC, San Juan, PR.

> **Clinical disclaimer.** This is a clinical decision *support* service. It does
> not prescribe, dispense, or replace clinician judgment. Recommendations derive
> from versioned CPIC guidelines in `knowledge/`; any model output is grounded in
> those rules and disabled until clinical sign-off.

**Status:** scaffold only. Remaster scope: TBD.

## Layout
| Path | Purpose |
| --- | --- |
| `apps/frontend` | Clinician-facing UI |
| `apps/backend` | NestJS API: REST + CDS Hooks, phenotype and recommendation engines |
| `apps/ai-service` | Model serving, retrieval, prompts, grounding evaluators |
| `packages/` | Shared types, FHIR utilities, CPIC schema |
| `knowledge/` | Version-controlled clinical knowledge (CPIC, PharmGKB, FDA labels) |
| `ml/` | Model training, evaluation, model cards (Python under `ml/training/`) |
| `data/` | **Synthetic data only** |
| `infrastructure/` | Docker, Terraform, Kubernetes, monitoring |
| `docs/` | Architecture, validation, regulatory |

## Data rules
No real PHI in git, `data/`, or `ml/`. Training data is synthetic or de-identified only.
