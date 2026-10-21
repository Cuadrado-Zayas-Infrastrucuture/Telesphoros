# Spec-driven workflow (GitHub Spec Kit)

[GitHub Spec Kit](https://github.com/github/spec-kit) is scaffolded in this repository for **multi-step feature work**: a feature is written as a spec, then a plan, then a task list, before code. A one-line fix or a single-function change does not use it; it gets the ordinary written plan from the [Working agreements](../STATUS.md#working-agreements).

The Working agreements and [CONTRIBUTING.md](../../CONTRIBUTING.md) stay authoritative. [`.specify/memory/constitution.md`](../../.specify/memory/constitution.md) restates them so the Spec Kit skills check them while planning; if it disagrees with them, it is wrong and is fixed in the same PR.

## Where things go

| Artifact | Location | Notes |
|---|---|---|
| Feature spec, plan, tasks | `specs/NNN-slug/` (`spec.md`, `plan.md`, `tasks.md`, plus any `research.md`, `data-model.md`, `contracts/`, `checklists/`) | **Default for new multi-step features.** `NNN` is assigned by `.specify/scripts/bash/create-new-feature.sh`. A `plan.md` the founder has approved satisfies Working agreement 1. |
| Status entry | `docs/status/YYYY-MM-DD-slug.md` | One fragment per pull request (`# Title`, then `Date: YYYY-MM-DD`), not a new section in `docs/STATUS.md`. `pnpm status:index` prints the index. |
| Verification record | `docs/verification/` | Unchanged. Spec Kit has no verification artifact; what was run, passed, skipped and left unverified is still recorded here and linked from the PR. |
| Clinical validation note | `docs/clinical-validation/` | Unchanged. Required for clinical-logic changes whatever the workflow. |
| Constitution | `.specify/memory/constitution.md` | Content, not scaffolding: a `specify init` upgrade must not regenerate it. |
| Spec Kit templates and scripts | `.specify/templates/`, `.specify/scripts/bash/`, `.specify/workflows/` | Scaffolding, version recorded in `.specify/integration.json`. An upgrade overwrites local edits to these. |
| Claude skills | `.claude/skills/speckit-*/` (10) | Installed per repository, not globally, so the version is pinned with the code. |
| Current-feature pointer | `.specify/feature.json` | Machine-local; ignored by `.specify/.gitignore`. Never committed. |

## What this did not replace

- **`docs/design/plans/`** and **`docs/verification/`** are unchanged and still valid. Existing plans are historical record, cited from merged commits and PR bodies: none is moved, edited, renumbered or migrated into `specs/` (consolidate forward: only new work changes shape).
- **The [Codex engineering workflows](workflows.md)** in `.agents/skills/` are unchanged. They are a separate pack for Codex; the `speckit-*` skills are not mirrored there.
- **Approval, PR and merge rules** are unchanged: the founder approves the plan before code, one draft PR per slice off `main`, merging only on the founder's word with every required check green.

## Using it

1. `/speckit-specify <feature description>` creates `specs/NNN-slug/spec.md`. Optionally `/speckit-clarify`.
2. `/speckit-plan` writes `plan.md`, including a constitution check. **Stop here for the founder's approval.**
3. `/speckit-tasks` writes `tasks.md` from the approved plan. Optionally `/speckit-analyze` for cross-artifact consistency.
4. `/speckit-implement` works only through that approved `tasks.md`; anything beyond it needs a new approval.
5. Record verification in `docs/verification/` as before.

`/speckit-taskstoissues` creates GitHub issues and is run only when the founder asks. The scripts name directories only; they create no git branches.

To preview the next feature number without writing anything:

```sh
.specify/scripts/bash/create-new-feature.sh --dry-run --json "short feature description"
```
