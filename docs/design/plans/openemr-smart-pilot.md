# Local synthetic OpenEMR SMART pilot

Founder approved fixing access and preparing a read-only synthetic pilot PR on 2026-10-11, then confirmed the original repository was deleted and replaced by Telesphoros-Remastered. This slice ports the isolated pilot to current main; it does not transplant the deleted repository's history or production code.

## Scope and decisions

- Add `packages/smart-pilot`: a separately runnable TypeScript development harness, synthetic HTTP fixtures, React viewer and tests. Use Remastered's frontend tokens. No production Nest module imports it.
- Add CLI provisioning and a source-hash-checked OpenEMR image under that package. Local ports 8301/8767, separate synthetic Docker project, generated ignored credentials, exact patient registrations.
- Replace legacy gateway CDS/medication dependencies with minimal local FHIR shape validation and fixture display. No clinical engine, persistence, demographic matching or evaluation.
- Add pnpm scripts, lockfile and scoped runbook/verification; update STATUS. Tests join workspace CI through the package scripts.
- Preserve PKCE/state/nonce, signed identity, exact mappings, read-only scopes, bounded requests/pagination, consent withholding and visible clinical limitations.

## Do not touch

Production API mounts/auth, database migrations/RLS, clinical engines, real knowledge, AWS/infrastructure configuration, production UI routes and clinical holds. No cloud deployment, merge or real data. Python provisioning is replaced with Node CLI scripts to fit this repository.

## Verification

Run strict TypeScript, lint, ported HTTP refusal/control tests, viewer tests/build, and both real synthetic OpenEMR browser launches. Verify ignored runtime files and secret signatures before commit. Inspect workspace CI; database/S3 tiers remain necessary for repository merge but this slice changes neither application schema nor storage. Report all skipped tiers and keep the PR draft for review.

## PR #66 review follow-up

Founder authorized CI/diff review and fixes while retaining draft status on 2026-10-11. Reproduce query-relative pagination, expiration during upstream reads, and viewer session replacement before fixing them. Review identity claim checks as part of the same isolated connector boundary. Add refusal/control regressions, rerun the real synthetic EHR workflow, and require current-head CI. No production scope, real data or clinical release change.
