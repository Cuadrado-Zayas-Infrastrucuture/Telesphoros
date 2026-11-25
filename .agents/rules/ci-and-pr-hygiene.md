---
trigger: model_decision
description: Apply when creating branches, writing docs/status fragments, editing CI or .agents workflows, or preparing a pull request.
---

# CI, Status Fragments & Pull Request Hygiene

## Branching & Status Fragments
- Always check live `origin/main` and open/recently merged PRs before branching; branch directly off up-to-date `main` and never commit to `main` or stack PRs.
- Every PR that changes repository state adds **one** fragment under `docs/status/YYYY-MM-DD-slug.md` with `# Title` on line 1 and `Date: YYYY-MM-DD` on line 3. Never append new sections to `docs/STATUS.md`.
- Validate status fragments and links with `pnpm status:index`, `node --test .github/ci/status-fragments.test.mjs`, and `node --test .github/ci/doc-links.test.mjs`.

## Workflow & `.agents` Pack Guards
- Any change under `.agents/skills/` must include `agents/openai.yaml` referencing `$<skill-name>` and a matching entry in `.agents/evals/routing.json` (≥3 positive and ≥2 negative cases), verified with `pnpm check:workflows`.
- Preserve all six required GitHub checks (`verify`, `database-and-storage`, `browser`, `terraform`, `secret-scan`, `image`) and pinned Action SHAs; run `pnpm test:ci-config` when touching CI files.
- Remember `.github/workflows/ci.yml` intentionally skips `ci/*` jobs on Draft PRs; mark a PR ready only after founder review.

## Pull Request Checklist
- Fill out `.github/pull_request_template.md` completely, including the safety invariants and Spanish disclosure line.
- Explicitly disclose AI tool involvement and what was verified by hand (`CONTRIBUTING.md`).
- Separate local checks from exact-head hosted Linux CI, staging AWS, and clinical approval — never equate local green with hosted or clinical sign-off.
