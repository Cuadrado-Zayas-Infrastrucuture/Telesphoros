---
name: telesphoros-tdd
description: Use test-driven development (TDD) for explicit test-first and red-green-refactor requests. Iterate one failing behavior test and minimal implementation, using independent expected values, agreed test seams and preserved service/security controls.
---

# Test an approved behavior first

Read the [repository context](../../references/telesphoros.md), [glossary](../../../docs/glossary.md), approved slice, actual callers/history and adjacent tests. This is the test-first method within [implementation](../telesphoros-implement-slice/SKILL.md); [verification](../telesphoros-verify/SKILL.md) retains acceptance ownership. It grants no additional execution, publication, model or deployment permission.

## Choose the observable contract

State the behavior and boundary under test, what it catches and what it cannot prove. Reuse existing interfaces, fixtures, helpers and meaningful regression controls. Approved plans and established contracts can already settle the boundary; do not demand another approval for each test. Unsettled requirements belong with [planning](../telesphoros-plan-change/SKILL.md). A real interface decision can use [codebase design](../telesphoros-codebase-design/SKILL.md), without automatic redesign or delegation.

Prefer behavior visible to callers over private structure, incidental call counts or a replacement abstraction invented for mocking. When ordering, effects or invocation counts are part of the actual contract, test them explicitly.

## Red, then the smallest green

1. Select one behavior and an independent oracle: a specified outcome, known literal or worked example. Do not recompute the expected value with the production algorithm/helper or derive fixtures from the same implementation.
2. Add or reuse the smallest test that detects the missing behavior or original defect through the relevant boundary. Run it against the unchanged implementation; retain the actual assertion failure and a meaningful success control. An import error, unavailable service, wrong setup or stale artifact is not the intended red. If execution is unavailable, report that gap rather than inventing red/green evidence or a speculative fix.
3. Implement only enough approved behavior to satisfy that test. Run it again, preserve the producer output/exit and inspect the result. Continue one behavior/test/change at a time; avoid writing an imagined batch of tests before learning from the first cycle.
4. For approved refactors, establish characterization coverage first. Small cleanup may follow a green cycle within the same approved intention, followed by affected checks. Do not require refactoring on every cycle or expand scope to obtain a preferred design. Review the final diff under the existing implementation process.

## Keep independent evidence

Use doubles deliberately for isolated boundary behavior; they cannot establish real SQL permissions, RLS, transactions, recovery or exact S3-version binding. Preserve independent catalog/database/security tests when they verify those contracts, including direct persistence observations. An API-only test or mock is not an automatic replacement. Reuse the documented synthetic services, restricted application roles, required profiles and recovery validators where applicable; missing services/skipped required tiers remain missing acceptance evidence.

Static documentation or low-impact configuration edits need appropriate existing checks, not artificial product unit tests. Clinical or product-model changes keep their separately approved validation gates.

**Return:** behavior/oracle/boundary, red command and actual failure reason, minimal change, green command/result, preserved controls and missing acceptance at the tested checkout. Distinguish proposed steps from executed evidence.

**Self-check:** Can the control detect the original defect? Is the oracle independent? Did setup fail instead of behavior? Did I preserve scope and independent service/security proof?
