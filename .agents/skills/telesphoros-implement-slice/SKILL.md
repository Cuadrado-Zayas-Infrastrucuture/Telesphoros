---
name: telesphoros-implement-slice
description: Implement an approved Telesphoros feature, API response, task or behavior-preserving refactor in one small verified slice. Use when asked to build, add, change or implement code under an approved plan; reuse existing contracts and prove new behavior with regression tests.
---

# Implement an approved slice

Read the [repository context](../../references/telesphoros.md) and the approved plan. Confirm the requested slice is approved; carry existing authorization forward instead of asking again. If only planning was authorized, stop before code.

1. Check the clean/dirty state, current main and relevant PR state before branching. Preserve unrelated changes. Inspect the actual callers, history, contracts and adjacent tests; reuse canonical helpers for tenant identity, failure states and source freshness.
2. Write the smallest observable acceptance/reproduction case for behavior changes. Run it against the unchanged implementation and retain the real failure. For existing behavior being refactored, establish characterization coverage first. Static documentation edits do not need artificial unit tests.
3. Implement one complete path. Preserve tenant/actor checks, parameterized SQL, append-only evidence, exact object versions and failure propagation. Design API changes at the existing contract boundary; a silent fallback or optional field must not conceal an invalid state. For UI, load the frontend instructions and design tokens before editing.
4. Evaluate the result, repair the cause of failures, then rerun affected checks. Use the context's verification matrix: real database/role/storage acceptance for schema or ACL changes, actual browser states for UI, and the existing clinical/prompt evals if that separately approved scope applies. Do not loosen a check to obtain green.
5. Review the complete diff and update the existing status/design/verification records. Commit only this slice on its main-based branch with the required agent trailer and session reference. If a PR is requested, use the repository template, open it as draft and stop for review. Before later pushes check the PR is still open; a fix after merge is a new PR off main.

**Return:** Implemented / Risks / Controls / Tests / Follow-ups, including commands, exit results, skipped acceptance and the diff/commit. Local success is not hosted acceptance or permission to merge/deploy.

**Self-check:** Does the failure control detect the original defect? Were all affected callers checked? Are there unapproved adjacent changes or claims unsupported by real evidence?
