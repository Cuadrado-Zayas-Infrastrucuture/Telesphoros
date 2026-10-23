# AGENTS.md

Instructions for AI coding agents working in this repository, for any tool. People: read [CONTRIBUTING.md](CONTRIBUTING.md) first.

## Read first
- [README.md](README.md): what the product is, and what is not approved for use.
- [docs/STATUS.md](docs/STATUS.md): what exists, what is open, and the working agreements.
- [docs/architecture.md](docs/architecture.md): the module boundaries.

## Setup and checks
The commands are in [CONTRIBUTING.md](CONTRIBUTING.md) under "Development setup". Before proposing a change, run typecheck, lint, test, build, `pnpm test:infra` and `pnpm test:ci-config`.

## Boundaries
- Synthetic data only. Never add real patient data, real reports, identifiers or secrets to the repository, tests, fixtures, logs or examples.
- Database queries are parameterized and scoped to the caller's tenant. See [docs/database.md](docs/database.md) and [docs/auth.md](docs/auth.md).
- Never commit to `main`. Work on a branch and open a pull request.
- Database changes are new numbered migrations with a matching down file. Never edit an applied migration.
- Changes to required checks or to the ruleset are maintainer decisions ([docs/ops/ci-cd.md](docs/ops/ci-cd.md)).

## Disclosure
Say in the pull request when an AI tool produced a change, and what was verified by hand.
