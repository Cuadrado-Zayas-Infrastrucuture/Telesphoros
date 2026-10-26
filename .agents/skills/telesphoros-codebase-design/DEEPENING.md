# Deepen a cluster without losing its contract

Use the [module vocabulary](SKILL.md#design-vocabulary). Start with a traced caller path, its required behavior and existing acceptance evidence. A smaller interface should move orchestration to its owner while preserving the contract.

## Dependencies determine the evidence

- **In-process:** computation or local state. Exercise behavior through the proposed interface; retain a focused internal test when it proves a distinct contract.
- **Local persistent services:** PostgreSQL, object storage or the filesystem. A stand-in can prove orchestration, while real integration tests establish persistence, transactions, ownership and failure behavior. Use the repository's PostgreSQL 16 and restricted-role checks for database claims; an in-memory substitute does not prove RLS or grants. Moto remains emulator evidence.
- **Remote but owned:** a separate process or service. Put a transport adapter at a justified seam. In-process tests can exercise business logic, while transport, identity, cancellation and deployment claims need their own evidence.
- **External provider:** isolate the provider contract where useful and use synthetic refusal/success controls. A mock proves handling of the supplied responses; it does not establish current provider behavior. Live calls and spend still require their existing authorization.

## Preserve the reason for the seam

Inspect who owns the transaction, current actor, cancellation and resource lifetime. An interface with one implementation can still enforce those responsibilities. Dependencies that vary internally need not all become public parameters, and an existing adapter should be reused before adding another layer.

## Compare coverage before removing tests

Map each old test's distinct claim to the evidence that will remain. Consolidate duplicated orchestration tests only when the replacement proves the same outcomes, refusal cases and meaningful success controls.

Keep independent application-role/RLS/ACL checks, schema/catalog and migration checks, crash/recovery and fault controls, and exact-version/append-only assertions when those claims apply. They exercise contracts a high-level in-memory test cannot replace. If equal coverage is unproven, retain the test and report the gap.

Use [the existing verification workflow](../telesphoros-verify/SKILL.md) for the changed boundary. This reference grants no test deletion, database activation, production change or new service installation beyond the approved task.
