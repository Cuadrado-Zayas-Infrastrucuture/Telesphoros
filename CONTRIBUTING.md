# Contributing

- Branch every PR off `main`; never stack PRs.
- Backend: NestJS, TypeScript on Node >=22. Workspace: pnpm. Python only under `ml/training/` and `sidecars/` (a sidecar is a small process the backend starts; today, `sidecars/report-reader/`).
- Parameterized SQL, every query tenant-scoped; no PHI in logs.
- A promise is awaited, handled or explicitly `void`ed: `pnpm lint` checks it with types (`scripts/lint/promise-rules.mjs`). A suppression names the rule and gives its reason after `--`; one that suppresses nothing fails lint.
- Changes to clinical logic need tests and a validation note in `docs/clinical-validation/`.
- Commits by agents carry a `Co-Authored-By` trailer.
- Database changes are **new numbered migrations** with a matching down file (never edit an applied one). Run the database tier before opening a PR: see docs/database.md. From migration 0028 each `.up.sql` starts with `-- compat: expand` or `-- compat: breaking` (use `breaking` when unsure); see "Migration labels" in docs/database.md.
- **Status entries are fragments.** A change that `docs/STATUS.md` would have described adds one file, `docs/status/YYYY-MM-DD-slug.md` (a `# Title` line, then `Date: YYYY-MM-DD`), so two pull requests never edit the same lines. Do not add sections to `docs/STATUS.md`. `pnpm status:index` prints the index, newest first; `pnpm test:ci-config` checks every fragment.
- Never put real patient data anywhere: not in the repository, not in tests, not in the dev database.
- **A green run without the database and S3 tiers proves nothing about the schema.** Those tiers are skipped (with a printed notice) unless TEST_DATABASE_URL / TEST_S3_ENDPOINT are set. CI sets them and fails the job if a tier prints that notice. See docs/database.md.
- The fake identity provider (packages/fake-idp) is TEST ONLY. Never deploy it, and never point production at it.
- Run `pnpm test:infra` after touching infrastructure/terraform: it fails if a security setting is weakened.
- `CLAUDE.md` only points at the documents above; put rules there, not in it. `pnpm test:ci-config` fails if it names a file that does not exist.

Reusable repository-scoped engineering skills and their evaluation commands are listed in [Engineering workflows](docs/engineering/workflows.md). They reference these working agreements and grant no additional permissions.

## Development setup

Requirements: Node.js 22.22.0 (CI pins this exact release), pnpm 10.28.0, Python 3 for the reader tests, and the PostgreSQL 16 client tools and `openssl` for the backup tests.

```bash
pnpm install --frozen-lockfile
pnpm typecheck && pnpm lint && pnpm test && pnpm build
pnpm test:infra && pnpm test:ci-config
```

The database and S3 test tiers are in [docs/STATUS.md](docs/STATUS.md#running-things-locally) and [docs/database.md](docs/database.md). A green run without them proves nothing about the schema.

## Reporting bugs and proposing changes

Use the issue forms. Do not put patient data, real reports, identifiers or credentials in an issue, a pull request or a log excerpt. Report security problems through [SECURITY.md](SECURITY.md), never in a public issue.

## Pull requests

- Each pull request states one intention. Describe what was verified by hand, and say whether an AI tool produced any part of it.
- Required checks are listed in [docs/ops/ci-cd.md](docs/ops/ci-cd.md). Changes to them, or to the ruleset, are maintainer decisions.

## Code of conduct

Everyone who takes part in this project follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Contributor licence

[DRAFT: a contributor licence agreement is pending counsel's review. Until it is in place, outside contributions cannot be accepted under a dual licence.]

## Merging to `main`

- `main` is protected by a ruleset (`.github/rulesets/main.json`, steps in [docs/ops/ci-cd.md](docs/ops/ci-cd.md)): a pull request is required, and
  `verify`, `database-and-storage`, `browser`, `terraform`, `secret-scan` and `image` must be green. Force pushes and deletion are blocked.
- **Required approvals are 0 while there is one maintainer** (the author cannot approve their own PR). When a second
  maintainer is added, the policy becomes **1 approval + the checks**, with code-owner review required for the paths in `.github/CODEOWNERS`.
- Every GitHub Action is pinned to a commit SHA; Dependabot updates them. Run `pnpm test:ci-config` after touching `.github/`.
- Secrets never go in the repository. `secret-scan` checks the whole history; explicit exceptions (test vectors, a dummy Moto secret-container name, the migration hash list) are in `.gitleaks.toml`, scoped by path, rule and line shape, never by commit hash, so they survive a history rewrite.
