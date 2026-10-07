# Contributing

- Branch every PR off `main`; never stack PRs.
- Backend: NestJS, TypeScript on Node >=22. Workspace: pnpm. Python only under `ml/training/`.
- Parameterized SQL, every query tenant-scoped; no PHI in logs.
- Changes to clinical logic need tests and a validation note in `docs/clinical-validation/`.
- Commits by agents carry a `Co-Authored-By` trailer.
- Database changes are **new numbered migrations** with a matching down file (never edit an applied one). Run the database tier before opening a PR: see docs/database.md.
- Never put real patient data anywhere: not in the repository, not in tests, not in the dev database.
- **A green run without the database and S3 tiers proves nothing about the schema.** Those tiers are skipped (with a printed notice) unless TEST_DATABASE_URL / TEST_S3_ENDPOINT are set, and CI must set them. See docs/database.md.
- The fake identity provider (packages/fake-idp) is TEST ONLY. Never deploy it, and never point production at it.
- Run `pnpm test:infra` after touching infrastructure/terraform: it fails if a security setting is weakened.
