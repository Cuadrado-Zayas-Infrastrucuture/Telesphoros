# Agent-skills attribution and adaptation

Two upstreams: Addy Osmani's agent-skills (this section) and mattpocock/skills (next section).

Upstream: [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills), revision [`aeac41d4d005999432bb7312f7ff06383a91d59d`](https://github.com/addyosmani/agent-skills/tree/aeac41d4d005999432bb7312f7ff06383a91d59d), inspected 2026-10-16. The seven local workflow skills and lexical routing evaluator are adapted from the following MIT-licensed material. They are project adaptations, not an upstream distribution or endorsement.

| Local workflow | Upstream concepts/files under `skills/` |
|---|---|
| `telesphoros-plan-change` | `spec-driven-development`, `planning-and-task-breakdown`, `idea-refine`, `interview-me` |
| `telesphoros-implement-slice` | `incremental-implementation`, `test-driven-development`, `api-and-interface-design`, `git-workflow-and-versioning`, `documentation-and-adrs` |
| `telesphoros-debug` | `debugging-and-error-recovery`; reproduce/localize/reduce/fix/guard |
| `telesphoros-verify` | `test-driven-development`, `browser-testing-with-devtools`; observable proof and meaningful controls |
| `telesphoros-review` | `code-review-and-quality`, `security-and-hardening`, `code-simplification`; five review axes and trust-boundary tracing |
| `telesphoros-optimize` | `performance-optimization`, `ci-cd-and-automation`; measure first and retain quality gates |
| `telesphoros-release-readiness` | `shipping-and-launch`; readiness, rollback limits and explicit release boundaries |
| Shared context and evaluator | `context-engineering`, `source-driven-development`, `scripts/run-evals.js`, `evals/README.md`; progressive context and lexical evaluation with stated limits |

Deliberate differences:

- Native skill discovery replaces an always-on `using-agent-skills` router. No upstream installers, hooks, commands, personas or plugin manifests are installed.
- Existing working agreements, query protocol, plans and verification records replace generic `SPEC.md`, task trees and a new `CONSTRAINTS.md` policy. No universal 100-line budget, coverage percentage or performance threshold is imported.
- `constraint-driven-development` contributes no replacement rules: the repository already has enforced constraints. `frontend-ui-engineering` remains governed by the existing frontend instructions/tokens.
- `doubt-driven-development` contributes the practice of trying to refute a claim during review; no delegation or cross-model mechanism is imported.
- `deprecation-and-migration` remains a separately scoped design task, using current migration rules. Generic migration/launch automation is excluded. `observability-and-instrumentation` changes use existing project runbooks; no third-party instrumentation or payload logging is installed.
- Main-run cancellation, six required checks, synthetic-only boundaries, domain approval and the distinction between emulator and hosted acceptance remain unchanged. A readiness workflow grants no deployment authority.
- The local evaluator reuses a small lexical-scoring approach. It does not run upstream behavioral executors or grant their tool permissions.

## Upstream license (retained verbatim)

MIT License

Copyright (c) 2025 Addy Osmani

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## mattpocock/skills: domain modeling

Upstream: [mattpocock/skills](https://github.com/mattpocock/skills), commit `5beb35b040e3` (committed 2026-10-19). The byte-for-byte reference copy and its MIT licence (Copyright (c) 2026 Matt Pocock) are in [vendor/mattpocock/](vendor/mattpocock/VENDORED.md); the licence text is in [vendor/mattpocock/LICENSE](vendor/mattpocock/LICENSE).

| Local workflow | Upstream files |
|---|---|
| `telesphoros-domain-modeling` | `skills/engineering/domain-modeling/SKILL.md`, `GLOSSARY-FORMAT.md`, `ADR-FORMAT.md` |

Deliberate differences:

- One glossary at `docs/glossary.md`, not a root `GLOSSARY.md` or a multi-context map; the repository has one context.
- ADRs follow the shape of `docs/adr/0001-repository-layout.md` (Status and Scope lines, Context, Decision), not a one-paragraph template.
- Clinical terms are proposed only and need the founder's review; clinical content and `knowledge/` are out of scope.
- An ADR records a decision someone with authority made; the skill does not mark one accepted on its own.
