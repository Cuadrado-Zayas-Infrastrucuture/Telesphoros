# CLAUDE.md

Telesphoros Remastered: CPIC-guided pharmacogenomic decision support. A pnpm monorepo (NestJS backend, React/Vite frontend, PostgreSQL 16 with
row-level security, S3, Cognito, Terraform). Synthetic data only; nothing here is approved for clinical use.

**Read first: `docs/ops/environments.md`** (what is applied in AWS now), **then `docs/STATUS.md`**: what exists, what is open, the
**Working agreements**, and how to run everything locally.
Then, as the task needs: `CONTRIBUTING.md` (rules for changes and merging), `docs/architecture.md`, `docs/design/records-and-corrections.md`
(the records and ledger specification), `docs/lab-report-reader.md` (the pipeline routes), `docs/database.md`, and the runbooks in `docs/ops/`.

This file only points. The rules live in those documents so they cannot drift apart; update them there, not here. Two that are easy to miss:

- **Plan before code.** `docs/STATUS.md` says what a plan contains and that the founder approves it first.
- **A green run without the database and S3 tiers proves nothing about the schema.** See "Running things locally" in `docs/STATUS.md`.
- **Some commands are refused for every agent session** (secrets, applies, force pushes): `docs/ops/agent-policy.md`.

This is the rebuild, a separate repository from the earlier Telesphoros gateway; that repository's conventions do not apply here.
