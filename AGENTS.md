# AGENTS.md

Instructions for AI coding agents working in this repository, for any tool. People: read [CONTRIBUTING.md](CONTRIBUTING.md) first.

## Read first
- [README.md](README.md): what the product is, and what is not approved for use.
- [docs/ops/environments.md](docs/ops/environments.md): what is applied in AWS now.
- [docs/STATUS.md](docs/STATUS.md): working agreements and history up to 2026-10-20 (newer entries live in `docs/status/`).
- [docs/architecture.md](docs/architecture.md): module boundaries and data flows.

## Stack & key directories
`pnpm@10.28.0` monorepo on Node `22.23.5` (`.nvmrc`), TypeScript 6, ESLint 10, Prettier 3.9.
- `apps/backend`: NestJS 12 API, PostgreSQL 16 (forced RLS, append-only hash-chained ledger), S3 versioned intake, Jest 30.
- `apps/frontend`: React 19, Vite 8, Tailwind 4, Vitest 5, Playwright, axe-core, strict branding gate (`apps/frontend/AGENTS.md`).
- `apps/worker`: PostgreSQL job queue, transactional outbox, verification and sweep workers.
- `apps/ai-service`: Model serving/grounding boundary (keep out of deterministic phenotype/recommendation engine).
- `packages/`: `shared-types`, `cpic-schema`, `help-content`, `jobs`, `fake-idp`, `smart-pilot`, `fhir-utils`.
- `infrastructure/`: Terraform (`terraform/`, `terraform-state/`), Docker guards; `knowledge/`: versioned clinical knowledge (`cpic/` empty until clinical sign-off); `sidecars/report-reader/`: Python test-only reader wrapper; `specs/` and `docs/status/`.

## Exact commands (run from repo root, Node `22.23.5`)
- Install: `pnpm install --frozen-lockfile`
- Core checks: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`
- Guards & status: `pnpm test:infra`, `pnpm test:ci-config`, `pnpm check:workflows`, `pnpm status:index`
- Backend DB/S3 tiers: `pnpm --filter @telesphoros/backend test`, `TEST_STORAGE=postgres pnpm --filter @telesphoros/backend test`, `TEST_STORAGE=postgres TEST_OBJECT_STORAGE=s3 pnpm --filter @telesphoros/backend test`, `pnpm --filter @telesphoros/worker test`
- Frontend checks: `pnpm --filter @telesphoros/frontend test`, `pnpm --filter @telesphoros/frontend check:chunks`, `pnpm --filter @telesphoros/frontend e2e`

## Default engineering loop & token efficiency
- **Explore before editing:** read the exact callers, contracts, and adjacent tests first; prefer targeted file reads over broad repo scans.
- **Plan before code:** present a scoped plan and get founder approval before writing code.
- **Minimal scoped diffs:** change only what belongs to the approved slice; reuse canonical helpers instead of duplicating logic.
- **Verify before finishing:** run the relevant verification commands after every code change, fix all failures without weakening tests, and report exact pass/fail/skip/not-run counts.
- **Context hygiene:** keep responses concise; remind the user to run `/compact` after major milestones and `/learn` after tricky fixes or workflow corrections.
- **Scoped rules & skills:** domain rules load automatically from `.agents/rules/*.md`; reusable workflows live in `.agents/skills/` (shared context in [.agents/references/telesphoros.md](.agents/references/telesphoros.md)).

## Hard boundaries
- **Synthetic data only.** Never add real patient data, real reports, identifiers, or secrets to code, tests, fixtures, logs, or examples.
- **Tenant isolation:** database queries are parameterized and scoped to the caller's tenant with forced RLS ([docs/database.md](docs/database.md), [docs/auth.md](docs/auth.md)).
- **Branch discipline:** never commit to `main`; branch off fresh `main`, open a pull request, and add one `docs/status/YYYY-MM-DD-slug.md` fragment (never append new sections to `docs/STATUS.md`).
- **Migrations:** database changes are new numbered up/down pairs; never edit an applied migration.
- **Protected gates:** changes to required checks (`verify`, `database-and-storage`, `browser`, `terraform`, `secret-scan`, `image`) or rulesets are maintainer decisions ([docs/ops/ci-cd.md](docs/ops/ci-cd.md)).
- **Clinical safety:** missing, unsupported, or contradictory evidence must end in a hold, never a guess. In an audit-only task, change no code, dependency, CI config, or paid resource.

## Core test contract
- Test behaviour through public contracts (HTTP API, service methods, stored rows, permissions, errors) using real PostgreSQL 16 / S3 / Playwright dependencies where applicable — never weaken, skip, or delete a valid failing test.
- Reproduce bugs with a failing test first; prove new guards by observing them fail on the defect; treat fixtures and external inputs as untrusted data.
- A test that did not run (`ENGINE ABSENT` / `NOT RUNNING`) is always reported as a skip/not-run, never as a pass.

## Disclosure
Say in the pull request when an AI tool produced a change, and what was verified by hand.
