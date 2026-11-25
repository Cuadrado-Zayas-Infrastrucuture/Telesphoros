# Lean Antigravity configuration: root AGENTS.md and scoped .agents/rules

Date: 2026-11-25

Added four flat, scoped rule files under `.agents/rules/` (`backend-and-migrations.md`, `frontend-and-ui.md`, `testing-and-verification.md`, and `ci-and-pr-hygiene.md`) using `glob` and `model_decision` triggers so domain rules load only when relevant, keeping always-on context minimal.

Refined root `AGENTS.md` (plain Markdown, under 150 lines) to surface the verified monorepo stack, key directories, exact `pnpm` commands, default engineering loop, and token-efficiency habits while preserving all existing boundaries, testing contracts, and AI disclosure rules. Left the existing 14 CI-tested skills in `.agents/skills/` untouched to avoid duplication or routing-eval churn.

No application code, dependencies, migrations, Terraform, or CI workflow behavior changed.
