---
name: telesphoros-plan-change
description: Plan and specify a Telesphoros feature, requirement, architecture change or ambiguous idea before implementation. Produce a scoped proposal with acceptance criteria, dependencies and founder decisions. Use for requests to plan, scope, design or break down work.
---

# Plan a Telesphoros change

Use the [repository context](../../references/telesphoros.md). Preserve the user's verb: a planning request produces a plan, not implementation.

1. Inspect real callers, adjacent tests, git history and relevant open PRs. Find the existing mechanism and named owner before proposing a replacement. Read the applicable design/clinical/database runbook only as needed.
2. State verified facts separately from labeled assumptions. Identify the concrete user outcome, current behavior and acceptance evidence. Ask only for a decision that changes scope, safety or expected behavior; continue independent reading while it is pending.
3. Open with the existing protocol's ≤10-line contract: objective, facts/assumptions, method, do-not-touch and why, output, self-check and the one founder decision. Wait for approval unless the user has already approved that same scope or said "just do it".
4. For substantial work, record the approved design under `docs/design/plans/`. Reuse a current plan; avoid introducing a second SPEC/tasks system. Break work into independently verifiable vertical slices, each off main. Name exact files/interfaces, dependencies, rollback limits and the relevant commands from the repository context.
5. Include refusal cases: cross-tenant access, wrong actor, stale/version-mismatched evidence, missing services and operational failure where applicable. A migration needs a new numbered up/down pair and real database acceptance; a clinical change needs its validation note and domain approval.

**Return:** a slice table (`scope | existing mechanism | acceptance evidence | dependencies | risk/decision`) and explicit unresolved questions. For a tiny edit, the short contract is sufficient.

**Self-check:** Are source claims anchored to code/history? Does each slice have an observable outcome? Are approval and clinical/hosted evidence being confused with a plan? Did the request actually authorize implementation?
