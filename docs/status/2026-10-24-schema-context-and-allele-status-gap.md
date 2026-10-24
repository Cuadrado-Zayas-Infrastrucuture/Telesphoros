# Knowledge schema: no way to express clinical context or allele status (2026-10-24)

Date: 2026-10-24

**Recorded (documentation only).** The knowledge format ([cpic-integration.md](../cpic-integration.md), schema 1.2) keys a recommendation cell only on the phenotype of each gene the guideline names (`when`: one phenotype per gene). Searching `packages/cpic-schema/src`, `docs/cpic-integration.md` and `docs/design/outcomes-and-reason-codes.md` for age group, population, indication and allele status found no field, rule or mention. Two consequences, both **unverified against real CPIC tables**, because `knowledge/cpic/` is empty and no real table has been read:

1. **Clinical context.** If a published table gives different recommendations by context (for example paediatric and adult rows for the same gene phenotype), a cell cannot say which context it is for. Two cells for one phenotype combination are not expressible, and a signer who enters only one row would turn a context-dependent recommendation into a context-free one. The engine cannot hold what the schema cannot express, so `held` is not a safety net here.
2. **Allele status.** A gene map can list any phenotype terms, so a result a lab reports as a phenotype (for example a positive or negative finding) can be stored and matched as one. What is missing is mapping from alleles to such a status (for example carrier of a named allele). The mapping methods are `diplotype-table`, `function-pair` and `activity-score` only. A report that gives only the genotype for such a gene ends as `other-gene-unresolved`, held, and is never mapped.

**Requirement, before the first real guideline file is signed.** The reviewing pharmacist reads each target table for rows that depend on context or allele status and records, in the sign-off, either "none" or the table and the dependency. A table with such a dependency is not signed until the schema can express it. This is a human check; no test enforces it today.

**Not changed:** the schema, loader, engine, any knowledge file, `BUILD_VERSION`, and the earlier requirements note [2026-10-23-ai-model-path-requirements.md](2026-10-23-ai-model-path-requirements.md). This note does not choose a fix (a context field on cells, an allele-status input type, or something else); that follows reading a real table.

**Source of the question.** An outside design sketch for a CPIC knowledge graph, which stated that recommendations can depend on population and clinical context and on allele status. The sketch's other rules (combined gene conditions, verbatim wording, explicit missing and conflicting results) are already enforced by the engine, and a graph store was not adopted.
