# Adopt module-interface design guidance

Date: 2026-10-25

**Implemented.** Adopted the pinned mattpocock codebase-design material as `telesphoros-codebase-design`, with module vocabulary, dependency/test guidance and a linear interface-comparison reference. The existing planning, implementation, review, verification and domain-modeling workflows retain their roles. The vendor source copy is unchanged; repository-owned provenance and discovery metadata identify the adoption.

**Adaptation.** Design vocabulary is scoped to module reasoning, preserving product terms, HTTP APIs, security boundaries and the report adapter's name. A single-adapter seam can still protect ownership or authority. Required side effects and independent PostgreSQL, migration, recovery and fault evidence remain explicit. Test deletion and parallel agents are not imported as automatic steps.

**Evaluation.** Existing routing: 40/40 before and after, with no existing prompt changing its first-ranked skill. Eight new fixed cases bring the total to 48/48. The first candidate scored 47/48 by attracting a generic pagination-planning request; narrowing only its description repaired that regression without changing any prompt. Added two manual scenario rubrics for the one-adapter security seam and design-only/linear comparison. Lexical routing and manual rubrics are not independent LLM behavior or safety acceptance.

**Scope.** No product, clinical, database, infrastructure, global agent configuration or runtime change. No glossary edit, ADR, hook, agent dispatch, paid model evaluation or deployment. The adopted instructions preserve the existing approval boundaries.
