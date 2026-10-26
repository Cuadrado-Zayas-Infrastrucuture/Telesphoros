# Documentation map

Start with [the local demo](start-here.md), then use the sections below for the part you are changing. [The repository README](../README.md) contains the infrastructure overview and folder map.

## Understand the product

- [Glossary](glossary.md): the shared product vocabulary.
- [Architecture](architecture.md): service boundaries, identity, records, files and jobs.
- [Product capabilities](product-capabilities.md): normal builds, local modes and gated features.
- [Status and working agreements](STATUS.md): project history and the development rules. Run `pnpm status:index` for the newer dated entries under `docs/status/`.
- [Repository layout decision](adr/0001-repository-layout.md): accepted folder rules and the remaining moves.

## Make and verify a change

- [Contributing](../CONTRIBUTING.md): tool versions, branch/PR rules and the required local checks.
- [Engineering workflows](engineering/workflows.md): the repository's skills and their evaluation commands.
- [Spec-driven workflow](engineering/spec-driven-workflow.md): Spec Kit and feature specs under `specs/`.
- [Backend setup](../apps/backend/README.md) and [database guide](database.md): storage profiles, migrations and real-service test tiers.
- [CI and delivery](ops/ci-cd.md): required checks and the difference between local, PR and deployment evidence.

## Work on records and access

- [Authentication and authority](auth.md): identity, membership, roles and revocation.
- [Membership operations](ops/membership.md): organization and membership administration.
- [Records and corrections](design/records-and-corrections.md): capture decisions, evaluations, corrections and the ledger; later amendments govern earlier passages.
- [Report-file evidence](ops/report-evidence.md): exact file versions, hashes and download links.
- [Jobs](ops/jobs.md): queue, outbox, worker and operational acceptance.

## Run a local demo

- [Start here](start-here.md): the first storage-demo walkthrough.
- [Local storage operations](ops/local-storage-operations.md): ownership, restart, recovery and teardown.
- [Storage browser tests](ops/local-storage-browser.md): database and browser prerequisites for acceptance testing.
- [Review demo](../scripts/local-review/README.md): the separately gated capture/review flow and its reader dependencies.

## Read the infrastructure design

- [Main Terraform root](../infrastructure/terraform/README.md): AWS resources, profiles and prerequisites.
- [Terraform state bootstrap](../infrastructure/terraform-state/README.md): separate state bucket, key and custody.
- [API hosting](ops/api-hosting.md) and [domains and hosting](ops/domains-and-hosting.md): runtime, edge, certificates and sign-in configuration.
- [Staging rehearsal](ops/staging-rehearsal.md): the approved staged procedure; deployment needs its own plan review and authorization.
- [Backup and restore](ops/backup-and-restore.md), [audit trail](ops/audit-trail.md) and [security events](ops/security-events.md): operations and evidence.

## Read the gated pipeline and AI work

- [Lab-report pipeline](lab-report-reader.md) and [adapter specification](design/report-adapter-spec.md): capture, review and evaluation boundaries.
- [CPIC integration](cpic-integration.md): knowledge loading and the clinical-content gates.
- [LLM harness specification](../specs/003-llm-harness/spec.md): explanation contracts, budgets, evaluation and release gates.
- [AI safety requirements](ai-safety-and-hallucination-controls.md): requirements for a future model path.

Design plans live in `docs/design/`; architecture decisions live in `docs/adr/`. Existing verification reports remain under `docs/verification/`; [ADR 0001](adr/0001-repository-layout.md) places generated evidence in `docs/evidence/` as a separate migration. A historical verification record establishes only its named revision and environment.
