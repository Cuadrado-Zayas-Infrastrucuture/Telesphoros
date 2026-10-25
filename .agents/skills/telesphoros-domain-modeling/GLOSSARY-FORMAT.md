# Glossary format

One file, `docs/glossary.md`, for the whole repository.

```md
# Telesphoros glossary

{One or two sentences: what this vocabulary covers.}

## Reports

**Report**:
{One or two sentences: what it is.}
_Avoid_: {other words people use for it}

## Clinical terms (needs founder review)

**{Term}**:
{Proposed definition.}
_Status_: needs founder review
```

## Rules

- **Be opinionated.** When several words name one concept, pick the best one and list the rest under _Avoid_.
- **Keep definitions tight.** One or two sentences. Say what the thing is, not what it does or how the code stores it.
- **Only project terms.** General programming concepts (timeouts, retries, error types) do not belong, even when the code uses them everywhere.
- **Group terms under subheadings** when clusters emerge.
- **Clinical terms stay proposed** under their own heading until the founder reviews them.

Adapted from mattpocock/skills `domain-modeling` (MIT); see [third-party notices](../../THIRD_PARTY_NOTICES.md).
