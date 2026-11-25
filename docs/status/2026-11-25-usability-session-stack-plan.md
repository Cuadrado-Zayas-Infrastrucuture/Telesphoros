# Plan: a local stack for the usability sessions, with the protocol's data

Date: 2026-11-25

Plan only. The revised usability protocol needs a build and data that no command prepares:
- `demo:storage` shows no genomic profile;
- `demo:review` has no decisions, follow-ups or modifier list;
- staging refuses follow-up writes.

Task 11 also needs a signed modifier list, and the only signed one is made inside a backend test. The plan proposes
`pnpm demo:session`. It is a loopback-only launcher that starts PostgreSQL, the API, the fake identity provider and an e2e frontend
build, seeds the protocol's data through the API's own routes, and signs a copy of a synthetic list with throwaway keys generated per
run. A CI test checks the stack against the protocol's machine-checkable pass conditions.

Decisions waiting:
- where the sessions run (SD-D1);
- which real drug stands for task 11's medication against the invented gene (SD-D2);
- the signing keys (SD-D3).

Record: [the plan](../design/plans/usability-session-stack.md). No code, script or test change.
