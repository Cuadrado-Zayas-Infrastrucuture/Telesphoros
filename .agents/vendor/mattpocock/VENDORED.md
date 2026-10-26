# Vendored: mattpocock/skills

Copied byte-for-byte from <https://github.com/mattpocock/skills> at commit `5beb35b040e3` (committed 2026-10-19). Licence: MIT, see [LICENSE](LICENSE).

Every file's git blob hash matches the upstream blob at that commit. Nothing here is installed as a plugin, and no hook from this folder is active.

This folder is a pinned reference copy. It sits outside `.agents/skills/` on purpose: skills there are discovered by agents, and each must have routing cases in `.agents/evals/routing.json`, checked by `.agents/scripts/check-workflows.mjs`. A skill is adopted by copying it into `.agents/skills/<name>/` in its own pull request, together with its routing cases.

## What is vendored

| Skill | Upstream path | Why |
|---|---|---|
| `improve-codebase-architecture` | `skills/engineering/improve-codebase-architecture` | Architecture review; visual report; adopted as [`telesphoros-improve-architecture`](../../skills/telesphoros-improve-architecture/SKILL.md) |
| `tdd` | `skills/engineering/tdd` | Test-first feature and bug work |
| `to-tickets` | `skills/engineering/to-tickets` | Turns findings into tickets |
| `triage` | `skills/engineering/triage` | Issue triage vocabulary |
| `git-guardrails-claude-code` | `skills/misc/git-guardrails-claude-code` | Blocks destructive git commands; hook not active |
| `domain-modeling` | `skills/engineering/domain-modeling` | `GLOSSARY.md` and ADR formats; adopted as [`telesphoros-domain-modeling`](../../skills/telesphoros-domain-modeling/SKILL.md) |
| `codebase-design` | `skills/engineering/codebase-design` | Shared module-design vocabulary; adopted as [`telesphoros-codebase-design`](../../skills/telesphoros-codebase-design/SKILL.md) |

## What is not vendored, and why

These overlap with the repository's own `telesphoros-*` skills in `.agents/skills/`, which are the house process (see [docs/engineering/workflows.md](../../../docs/engineering/workflows.md)):

- `code-review` overlaps `telesphoros-review`.
- `to-spec` overlaps `telesphoros-plan-change`.
- `implement` overlaps `telesphoros-implement-slice`.
- `diagnosing-bugs` overlaps `telesphoros-debug`.

## Updating

Re-pin on purpose: pick a new upstream commit, re-copy the files, re-verify each blob hash, and update the commit above. Do not edit vendored files in place. A local change belongs in the adopted copy under `.agents/skills/`, which the repository owns.
