# Contributing

- Branch every PR off `main`; never stack PRs.
- Backend: NestJS, TypeScript on Node >=22. Workspace: pnpm. Python only under `ml/training/` and `sidecars/` (a sidecar is a small process the backend starts; today, `sidecars/report-reader/`).
- Parameterized SQL, every query tenant-scoped; no PHI in logs.
- Changes to clinical logic need tests and a validation note in `docs/clinical-validation/`.
- Commits by agents carry a `Co-Authored-By` trailer.
- Database changes are **new numbered migrations** with a matching down file (never edit an applied one). Run the database tier before opening a PR: see docs/database.md. From migration 0028 each `.up.sql` starts with `-- compat: expand` or `-- compat: breaking` (use `breaking` when unsure); see "Migration labels" in docs/database.md.
- Never put real patient data anywhere: not in the repository, not in tests, not in the dev database.
- **A green run without the database and S3 tiers proves nothing about the schema.** Those tiers are skipped (with a printed notice) unless TEST_DATABASE_URL / TEST_S3_ENDPOINT are set. CI sets them and fails the job if a tier prints that notice. See docs/database.md.
- The fake identity provider (packages/fake-idp) is TEST ONLY. Never deploy it, and never point production at it.
- Run `pnpm test:infra` after touching infrastructure/terraform: it fails if a security setting is weakened.
- `CLAUDE.md` only points at the documents above; put rules there, not in it. `pnpm test:ci-config` fails if it names a file that does not exist.

Reusable repository-scoped engineering skills and their evaluation commands are listed in [Engineering workflows](docs/engineering/workflows.md). They reference these working agreements and grant no additional permissions.

## Merging to `main`

- `main` is protected by a ruleset (`.github/rulesets/main.json`, steps in [docs/ops/ci-cd.md](docs/ops/ci-cd.md)): a pull request is required, and
  `verify`, `database-and-storage`, `browser`, `terraform`, `secret-scan` and `image` must be green. Force pushes and deletion are blocked.
- **Required approvals are 0 while there is one maintainer** (the author cannot approve their own PR). When a second
  maintainer is added, the policy becomes **1 approval + the checks**, with code-owner review required for the paths in `.github/CODEOWNERS`.
- Every GitHub Action is pinned to a commit SHA; Dependabot updates them. Run `pnpm test:ci-config` after touching `.github/`.
- Secrets never go in the repository. `secret-scan` checks the whole history; explicit test-vector exceptions are in `.gitleaks.toml`; `.gitleaksignore` names one exact historical false positive for a dummy Moto secret-container identifier.
