# Compare different interfaces

Use this reference for a chosen module whose interface still has meaningful alternatives. Read the [design vocabulary](SKILL.md#design-vocabulary) and the relevant [dependency guidance](DEEPENING.md).

Frame the current caller path, constraints, existing seams and acceptance evidence first. Keep the current interface as the comparison baseline. Explore materially different alternatives, such as hiding orchestration behind a small operation, shaping the common caller directly, or exposing a dependency port where real variation or authority requires it. Avoid a fixed method-count target or speculative flexibility.

Work through alternatives linearly by default. The upstream parallel-agent pattern is not automatic here: delegation requires the user's explicit request and the repository's existing conditions. A request to compare interfaces alone does not authorize agents, cross-model calls or paid evaluations.

For each viable alternative, show:

- The caller-facing types and example usage, including ordering, effects and refusal behavior.
- What callers no longer need to coordinate and what remains explicit.
- Seam placement, transaction/resource ownership and dependency adapters.
- Preserved invariants, transition risk and the evidence needed to distinguish it from the current design.

Compare caller knowledge, depth and locality against the same requirements. Recommend the strongest design with its concrete trade-off; retain the current design when no alternative earns its cost. A design-only task stops at the proposal. Any implementation uses the existing approval and verification workflow; this comparison grants no merge or deployment authority.
