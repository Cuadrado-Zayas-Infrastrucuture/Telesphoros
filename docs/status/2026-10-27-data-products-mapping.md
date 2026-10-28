# Data products: current-code mapping and the clinician-decision plan (spec 006)

Date: 2026-10-27

**Status (2026-10-28):** the founder approved D1 to D5, D7 and D8 on 2026-10-27; D6 (vocabulary `cdr-v1`) is held for the founder's edits. Slice D01a merged as PR #109. D01b has not started. The founder's 2026-10-27 data-product report was mapped against `main` `704d5c4` in [specs/006-clinician-decision-records/research.md](../../specs/006-clinician-decision-records/research.md), with a spec, data model, contracts and a two-slice plan (D01a result reference, D01b clinician result decisions) in the same directory.

Findings that change the report's assumptions:
- the stored result UUID and ordinal are already in the ledger projection, so D01a needs no migration;
- `disposition` is already the engine's held/evaluated field, so the new record is a "clinician result decision";
- the repository's idempotency convention is a body `requestId`, not a header;
- a new ledger record kind makes D01b's migration `breaking` (planned as 0052; `main` now holds 0052 and 0053, so D01b takes 0054 or later).

Not changed: any code, migration, test, knowledge file, CI, infrastructure, or the 2026-10-19 data-product plan and gap analysis (kept as history; superseded assumptions are listed in the research file). Nothing was run against a database, AWS or a model.
