# Contributing

- Branch every PR off `main`; never stack PRs.
- Backend: NestJS, TypeScript on Node 24. Workspace: pnpm. Python only under `ml/training/`.
- Parameterized SQL, every query tenant-scoped; no PHI in logs.
- Changes to clinical logic need tests and a validation note in `docs/clinical-validation/`.
- Commits by agents carry a `Co-Authored-By` trailer.
