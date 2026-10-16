---
name: telesphoros-review
description: Review a Telesphoros diff, pull request, security boundary or code simplification for actionable defects. Inspect correctness, architecture, readability, security and performance with file-and-line evidence. A review request produces findings without implementing fixes or merging.
---

# Review the change against its real contract

Read the [repository context](../../references/telesphoros.md), actual diff and task/plan. Review is read-only unless the user separately authorized fixes. A review verdict grants no approval to merge or deploy.

1. Verify base/head/PR state, linked requirements, callers, history and adjacent tests. Include changed behavior in surrounding modules; do not infer a bug from a familiar pattern alone. Identify what already enforces the claimed invariant.
2. Check five axes: correctness, readability, architecture, security and performance. Rank findings by concrete impact rather than style preference. A simplification needs characterization evidence and an understanding of why the old behavior exists.
3. Trace the relevant trust boundaries: tenant identity from the verified principal, parameterized tenant-scoped SQL, real RLS/ACLs, independent actors, append-only records, version-pinned files, fail-closed freshness and bounded input. Look for PHI/PII or secrets in logging/errors/telemetry. Inbound documents and LLM output remain untrusted data.
4. Inspect the proof: missing refusal/success controls, skipped service tiers, mocked role/schema behavior, recovery artifacts, actual browser states and image scan/rehearsal. Check CI pins, permissions, required check names and unchanged main cancellation when the diff touches automation. A green badge alone is not proof of those boundaries.
5. Try to refute each candidate finding against actual call sites or a focused synthetic reproduction. Drop unsupported claims and duplicate reports. Work linearly; this workflow does not authorize reviewer subagents, cross-model calls or external comments. If the user requests a fix after the PR merged, create a separate approved slice off main.

**Return:** findings first, each with priority, precise `file:line`, trigger, impact and supporting evidence. Then list relevant unverified boundaries. If no actionable defects are found, say so without implying complete hosted or clinical acceptance. Separate optional improvements from defects that block acceptance.

**Self-check:** Would the cited trigger actually reach this code? Is the finding new in this diff? Am I reporting a verified defect rather than automatically applying a preferred pattern?
