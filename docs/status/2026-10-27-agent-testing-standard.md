# Working agreement: how agents test

Date: 2026-10-27

`AGENTS.md` gains a Tests section, so every coding agent reads the same testing standard rather than a copy pasted into one session. It is the founder's SDET standard, condensed and fitted to this repository:

- Agents prefer real dependencies, and use the existing PostgreSQL 16 and S3 harness, not Testcontainers.
- Tests assert through public contracts.
- Bugs are reproduced first, and a new guard is proved by removing it.
- A failing test is never weakened to get green.
- Tests cover tenant isolation, roles, row-level security, concurrency and safe clinical failure.
- Fixtures and outside responses are treated as untrusted data.
- Property-based and mutation testing are used where they find real defects.
- Reports name every tier run, every remaining mock and everything not run, and a skip is never reported as a pass.

Documentation only: no code, test, CI or required-check change.
