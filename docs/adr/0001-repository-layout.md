# 0001. Repository layout

- **Status:** accepted for the rules below, 2026-10-25. Each move listed under "Consequences" is its own pull request.
- **Scope:** top-level folders of this repository, and where each kind of file belongs.

## Context

The repository has grown in several directions at once. Generated verification evidence sits among design documents in `docs/`. Test fixtures are in three places. Knowledge content is in more than one. A new developer cannot tell from the tree where a given kind of file belongs.

## Decision

Each kind of file has one home. The rules are:

1. **A file has one home.** If two folders could hold it, the one named here is correct, and a file in the other one moves.
2. **Code is grouped by what runs.** `apps/` holds deployable units. `packages/` holds shared libraries. `sidecars/` holds small processes that the backend starts; it stays at the root, because `CONTRIBUTING.md` names it.
3. **Tests live with the code they test.** Cross-application suites live in `tests/`.
4. **Fixtures live in `data/fixtures/`.** Nowhere else. Synthetic data only.
5. **Generated output is not documentation.** Evidence, reports and build artifacts are kept out of the reading path. Their home is `docs/evidence/`.
6. **Each top-level folder has a README** that says what belongs in it and what does not.
7. **Vendored code is not edited in place.** Pinned upstream copies live in `.agents/vendor/`. A change goes upstream, or into the adopted copy under `.agents/skills/`.
8. **Specs use Spec Kit.** Feature specs live in `specs/NNN-slug/`, with the Spec Kit tooling in `.specify/`.

Target top-level tree:

```
apps/            deployable services
packages/        shared libraries
sidecars/        small processes started by the backend (Python)
infrastructure/  Terraform, one root per stack
knowledge/       clinical reference content (single home)
data/fixtures/   all synthetic fixtures (single home)
specs/           feature specs; the Spec Kit tooling is in .specify/
docs/            reading material: adr/, design/, engineering/, ops/, status/, clinical-validation/, evidence/
tests/           cross-application suites only
scripts/         grouped by purpose, with scripts/README.md
.agents/         agent skills in skills/; pinned upstream copies in vendor/ (not discovered)
.claude/         Claude Code settings and hooks only
```

## Consequences

Moves, each in its own pull request after the reference search for that move. Counts are files on `main` at `aaadb04` that mention the path.

- `docs/verification/` to `docs/evidence/`. 32 files reference the old path, including `.specify/memory/constitution.md`, `docs/ops/ci-cd.md`, `infrastructure/terraform/README.md` and `infrastructure/terraform-state/README.md`.
- Consolidate fixtures into `data/fixtures/`. 21 files reference `data/fixtures`; `tests/backup_fixtures` is referenced by 2 files and `scripts/test-fixtures` by 6.
- Remove the empty `ml/` scaffolding, but only together with `CONTRIBUTING.md`'s rule that Python lives under `ml/training/` and `sidecars/`, in the same pull request.

No move is made to `sidecars/`, `knowledge/` or `specs/`. `knowledge/` is referenced by 79 files, `specs/` by 47 and `sidecars/` by 19, and `CONTRIBUTING.md` names `sidecars/`; a move would touch more than the layout.

Each `README.md` in a top-level folder is written in the pull request that makes its folder's contents final.

## Alternatives considered

- **Feature folders now.** Deferred. The layout must be stable before features are grouped, and feature grouping would move most of `apps/`.
- **Moving `sidecars/` under `tools/`.** Rejected for now. It would change a rule in `CONTRIBUTING.md` and gain nothing that a README does not provide.
- **Retiring Spec Kit.** Rejected. `docs/engineering/workflows.md` and `docs/engineering/spec-driven-workflow.md` describe it.
