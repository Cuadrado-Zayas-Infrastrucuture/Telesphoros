---
name: telesphoros-git-guardrails
description: Audit Git safety hooks and prepare inactive guardrail policies with offline allow/block tests. Use for explicit Git guardrails, destructive-command prevention or Claude Code hook coverage requests; ordinary approved Git delivery keeps its existing workflow.
---

# Review Git safeguards before activation

Read the [repository context](../../references/telesphoros.md), approved scope, actual Git configuration/history and [pinned source](../../vendor/mattpocock/git-guardrails-claude-code/SKILL.md). This workflow audits and prepares a local proposal. It installs no hook and grants no destructive operation, publication, delegation or activation authority.

## Establish the boundary

Identify the host, intercepted tools and project/global scope. A Claude Code `PreToolUse` Bash hook is not a Git hook, a Codex control or universal command enforcement. Inspect existing settings and hooks without exposing unrelated values, secrets or command payloads. Preserve their contents and provenance; do not overwrite configuration or disable other safeguards.

Carry existing approval forward for reversible work. Do not reopen a settled scope. Global installation or live activation needs its own explicit authorization and concrete configuration diff; installation permission is not permission to execute blocked operations.

## Test a stated policy

Agree which operations need refusal or human review and which ordinary operations remain available. Upstream blocks every push, including normal pushes; do not silently impose that policy on an approved delivery task. Destructive actions retain the existing written blast-radius and recovery requirement. Read-only inspection can proceed under the current task.

Inspect any candidate classifier before running it. Send synthetic command strings as data to a reviewed parser only; never execute the tested Git commands, use `eval`, or create destructive Git reproductions. Include ordinary allow controls, actual destructive forms, Git options/combined flags, quoted harmless text, malformed payloads and missing dependencies. Preserve complete permitted producer output/exit before summarizing results. Do not send real command payloads or secrets to an external model.

The [offline reference audit](scripts/audit-reference.py) runs only the hash-pinned upstream classifier over nine fixed probes. Run `python3 .agents/skills/telesphoros-git-guardrails/scripts/audit-reference.py`. Exit 0 means those probes meet the sample policy; exit 1 reports policy gaps; exit 2 means the audit could not complete. It is not an installable hook, a general shell parser or exhaustive enforcement proof. The sample all-push refusal is an audit target, not an accepted repository policy.

## Stop at the evidence

The pinned regex hook has demonstrated bypasses, false positives and fail-open input/dependency failures. Keep it inactive; a few matching examples cannot establish coverage. Surface unsupported syntax, wrappers and tool/host gaps rather than claim a security boundary or invent a parser. A stronger runtime implementation requires a separately scoped design and validation decision.

For a future authorized configuration change, inspect the exact host's current contract, merge only the approved hook entry, retain a recoverable preimage and verify unrelated hooks remain intact. Test host interception separately from offline classification; no live smoke test should perform a destructive action. [Verification](../telesphoros-verify/SKILL.md) and the existing review/PR gates still apply.

**Return:** scope/host, proposed policy, files affected, allow/refusal results with producer exits, bypasses/false positives, preservation evidence and activation decision still required. Distinguish proposal, offline result and actual host enforcement.
