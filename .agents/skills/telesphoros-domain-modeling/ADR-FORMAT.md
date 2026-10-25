# ADR format

ADRs live in `docs/adr/` with sequential numbers: `0001-slug.md`, `0002-slug.md`. Scan the folder for the highest number at write time and add one.

## Template

Follow [ADR 0001](../../../docs/adr/0001-repository-layout.md):

```md
# NNNN. {Short title of the decision}

- **Status:** proposed | accepted, YYYY-MM-DD | superseded by NNNN
- **Scope:** {what the decision covers}

## Context

{Why a decision was needed.}

## Decision

{What was decided.}
```

`## Consequences` and `## Alternatives considered` are optional. Add them only when the downstream effects or the rejected options are not obvious. A short ADR is fine: the value is recording that a decision was made, and why.

## When to offer one

All three must be true:

1. **Hard to reverse:** changing your mind later costs something real.
2. **Surprising without context:** a future reader would wonder why it was done this way.
3. **A real trade-off:** there were genuine alternatives, and one was picked for stated reasons.

Examples that qualify here: a storage or identity provider choice, a tenant-isolation mechanism, a boundary between services, a deliberate deviation from the obvious path, or a constraint not visible in the code (for example a compliance rule).

Adapted from mattpocock/skills `domain-modeling` (MIT); see [third-party notices](../../THIRD_PARTY_NOTICES.md).
