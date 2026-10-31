# Every agent session in the repository gets the same refusals

Date: 2026-10-30

**Implemented.** `.claude/settings.json` is committed with deny rules only: reading `.env` secrets, Terraform and OpenTofu
apply and destroy, force pushes and pushes to `main`, and writes to the ruleset API. It reaches every Claude Code session in a
clone, and no personal setting can lower it. `.claude/settings.local.json` is now ignored by the repository. CODEOWNERS names
the agent instruction files (`.claude/`, `.agents/`, `.specify/`, `AGENTS.md`, `CLAUDE.md`) and every `*.guard.test.mjs`.
`pnpm test:ci-config` refuses a dropped rule or an allow, ask, hook or env entry. A fresh headless session with every Bash
and Read call allowed refused all 10 denied calls and ran all 6 controls ([agent-policy.md](../ops/agent-policy.md)).

**Not established.**
- A rule matches the command as written; another invocation of the same program (`git -C`, a script) passes.
- Code-owner review is still not a merge requirement, and agents still push as the founder: both wait on agent identity.
- No Codex equivalent yet.
