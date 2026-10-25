# Reusable engineering workflows

Eight repository-scoped skills adapt outside material to Telesphoros's existing engineering process: seven from [Addy Osmani's agent-skills](https://github.com/addyosmani/agent-skills/tree/aeac41d4d005999432bb7312f7ff06383a91d59d), and domain modeling from [mattpocock/skills](https://github.com/mattpocock/skills), whose pinned reference copy is in [`.agents/vendor/mattpocock/`](../../.agents/vendor/mattpocock/VENDORED.md). They are checked-in instructions, not runtime agents or GitHub Actions. They add no cloud integrations, hooks, background work or permissions. The [source mapping and MIT notice](../../.agents/THIRD_PARTY_NOTICES.md) record what was adopted and deliberately left out.

## Use a workflow

Open Codex in this repository and start a new session to discover `.agents/skills/`. Invoke a skill by name, or describe a matching task. [Codex's native repository discovery](https://learn.chatgpt.com/docs/build-skills) loads the chosen skill on demand. No global installation is needed. Other agents can read the same `SKILL.md` explicitly; these files do not register Claude slash commands.

| Workflow | Example request | Deliverable and gate |
|---|---|---|
| [Plan change](../../.agents/skills/telesphoros-plan-change/SKILL.md) | `Use $telesphoros-plan-change to scope a bounded report list API.` | Existing-mechanism review, acceptance criteria, slice/decision table; founder approves implementation scope. |
| [Implement slice](../../.agents/skills/telesphoros-implement-slice/SKILL.md) | `Use $telesphoros-implement-slice for the approved pagination slice.` | Small branch/diff, regression and success controls, appropriate real checks; draft PR only when requested. |
| [Debug](../../.agents/skills/telesphoros-debug/SKILL.md) | `Use $telesphoros-debug: the worker exits successfully but produces no fresh output.` | Reproducer, producer evidence, isolated cause, minimal fix within approval and regression proof. |
| [Verify](../../.agents/skills/telesphoros-verify/SKILL.md) | `Use $telesphoros-verify to assess whether this migration has enough acceptance evidence.` | Claim/command/checkout/result matrix; missing or skipped tiers cannot establish acceptance. |
| [Review](../../.agents/skills/telesphoros-review/SKILL.md) | `Use $telesphoros-review on this diff, including its tenant boundaries.` | Prioritized file/line findings and evidence gaps; review stays read-only. |
| [Optimize](../../.agents/skills/telesphoros-optimize/SKILL.md) | `Use $telesphoros-optimize to evaluate slow database CI without weakening recovery tests.` | Matched measurements, cost basis and keep/defer/reject decision; new spend and risky work need approval. |
| [Release readiness](../../.agents/skills/telesphoros-release-readiness/SKILL.md) | `Use $telesphoros-release-readiness for the synthetic staging candidate.` | Evidence/owner/blocker table bounded to candidate/environment; no implicit merge, apply or deployment. |
| [Domain modeling](../../.agents/skills/telesphoros-domain-modeling/SKILL.md) | `Use $telesphoros-domain-modeling: the code says organization but the docs say tenant.` | Canonical terms in `docs/glossary.md`, contradictions with file references, ADRs in `docs/adr/` only for hard-to-reverse trade-offs; clinical terms stay proposed until the founder reviews them. |

The [shared repository context](../../.agents/references/telesphoros.md) links commands and sensitive invariants to their existing sources. Read only the relevant skill and domain references. Keep the pack with the repository: individual skill-folder copies omit the shared context. Do not paste all skills into `AGENTS.md` or load an additional always-on router. Existing approved scope carries forward; invoking another skill does not require another approval of the same reversible work.

Multi-step features are specified in `specs/NNN-slug/` with GitHub Spec Kit's Claude skills; see [Spec-driven workflow](spec-driven-workflow.md). It does not change this pack.

## Evaluate changes to the workflows

From the repository root, using the workflow's pinned Node release:

```sh
pnpm check:workflows   # runs both commands below
node .agents/scripts/check-workflows.mjs
node --test .agents/scripts/check-workflows.test.mjs
# Optional local comparison with a read-only checkout of the pinned upstream:
node .agents/scripts/check-workflows.mjs --baseline /path/to/agent-skills
```

The checker validates skill frontmatter, local linked files, UI invocation names, eval coverage and deterministic routing. The committed prompts in [routing.json](../../.agents/evals/routing.json) are fixed user requests, with positive owners and negative competitors. The optional `--baseline` comparison uses the seven selected upstream descriptions versus the seven skills adapted from them, so the catalog sizes match. It does not compare all 25 upstream skills with the local ones, and it leaves out domain modeling, which has no counterpart there (routing cases without `upstream_name`).

Routing is a stemmed lexical approximation adapted from the upstream evaluator. A high score is not evidence that an LLM follows safety or approval instructions. [Scenario rubrics](../../.agents/evals/scenarios.json) cover approval continuity, skipped tiers, failure propagation, tenant access, cost equivalence, untrusted text and release boundaries. Exercise them on synthetic artifacts and record observable outcomes. Separate manual walkthroughs from independent model evaluations; no skill authorizes subagents, paid evaluations or running a hosted agent by itself.

For changes, preserve the first evaluation, repair observed gaps and record before/after results against the same prompts. Do not rewrite a failing prompt to match a description. Record evidence for this adoption in the [verification record](../verification/engineering-workflows.md). The required `verify` job runs `pnpm check:workflows` on every pull request, including documentation-only ones, so a broken link or a missing routing case blocks the merge. The `--baseline` comparison stays local.

## Maintenance

Update the source mapping deliberately after reviewing an upstream revision. Retain the MIT notice. Recheck repository commands and linked contracts when their producers change. Avoid copying generic upstream workflow YAML, numerical quality thresholds, telemetry integrations, new approval systems or auto-shipping defaults into this regulated repository.
