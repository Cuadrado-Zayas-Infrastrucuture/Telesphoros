---
name: telesphoros-codebase-design
description: Shape a Telesphoros module's interface for testability and depth. Compare alternative interfaces, locate seams and adapters, and reduce caller knowledge of implementation details. Use for deepening an existing module or choosing a module interface.
---

# Design a module around its callers

Read the [repository context](../../references/telesphoros.md), real callers and adjacent tests. This skill supports choices about a module's interface; the house planning, implementation, review and verification workflows retain their roles and approval boundaries. A design request produces a proposal, and existing approval carries forward for work already in scope.

## Design vocabulary

Use this vocabulary when reasoning about module shape. The [product glossary](../../../docs/glossary.md), HTTP APIs, services, security boundaries and the report adapter keep their existing meanings; these design terms do not require renaming them.

- **Module:** code with an interface and an implementation; it may be a function, class, package or a slice crossing services.
- **Interface:** everything callers must know to use the module correctly, including invariants, ordering, failure modes, configuration and resource bounds as well as types.
- **Implementation:** the code behind that interface.
- **Seam:** a place where behavior can vary without changing its callers.
- **Adapter:** an implementation satisfying a dependency interface at a seam.
- **Depth:** useful behavior behind a small interface; implementation line count is not its measure.
- **Leverage:** the capability callers get for the interface they must learn.
- **Locality:** the concentration of related changes, knowledge and verification in one place.

## Shape the proposal

1. Trace callers, dependency creation, history and existing tests before suggesting a new abstraction. Name the complexity callers currently coordinate and the invariants it protects: tenant/actor authority, transaction ownership, exact file versions, append-only records and bounded work where relevant.
2. State the caller contract, including side effects and failures. Hide orchestration callers should not own, while keeping consequential effects explicit. Returning a value cannot replace a required ledger write or transaction.
3. Look for repeated caller orchestration and interfaces nearly as complex as their implementations. Use the deletion thought experiment: would the behavior have to be rebuilt across callers? Treat method counts and this thought experiment as prompts for investigation, not proof that code or tests should be removed.
4. Reuse existing seams when their purpose still holds. Real variation is a reason for an adapter; a single implementation can also protect ownership, authority or a process boundary. Do not add a fake adapter solely to satisfy a two-adapter rule, or remove a boundary solely because it has one implementation.

For consolidating a cluster, read [Deepening](DEEPENING.md). When comparing alternative interfaces, read [Design it twice](DESIGN-IT-TWICE.md). Load only the relevant reference.

Keep tests that establish independent security, persistence, transaction and failure behavior. Propose removing a genuinely duplicated test only after showing where its observable contract remains covered. In-memory adapters and emulators do not establish real PostgreSQL role/schema behavior or AWS acceptance.

**Return:** the proposed interface and a caller example, what it hides, seam/dependency choices, concrete trade-offs, preserved invariants, and a verification/transition plan tied to current files. Separate design advice from implementation and approval. Shared terminology changes belong to domain modeling; a hard-to-reverse architecture decision uses the existing ADR process.

**Self-check:** Is caller knowledge reduced? Does an existing seam already do this? Did a design preference weaken an authority boundary or its evidence? Am I still doing the user's requested work?
