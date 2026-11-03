# Structured synthetic report inspection and patient-link review — 032 S2a

Date: 2026-11-02

## Implemented

A clinician can upload an S1 JSON package through the existing chat attachment/details flow. Its report panel reads the pinned object version, verifies size/type/hash and the strict synthetic contract, then shows laboratory evidence, uncertainty, assay limitations and declared revision. Uploaded assessment/rule content never becomes a generated result. The compact panel retains upload verification before record status and keeps findings behind a disclosure.

An independent reviewer can confirm or reject the source-to-patient association with a coded reason and explicit confirmation. The API requires the preview's patient UUID, source hash/version and source patient reference. It reuses the existing append-only decision and ledger transaction, including concurrent retry handling and actor separation. An expected-binding check closes the gap between preview validation and the existing service's reread. The browser clears ambiguous save results and aborts stale reads when switching records.

The API requires an owned, disposable loopback PostgreSQL/S3 profile with clinical processing disabled. The UI requires the owned-storage build and 127.0.0.1. Ordinary profiles, readers/admin-only callers, cross-tenant access, self-review and stale/missing/corrupted source versions are refused.

## Verification

| Check | Local result |
| --- | --- |
| New API + controller input boundaries | 85 passed: 13 real PostgreSQL/S3 API cases and 72 exhaustive input-boundary cases. |
| Frontend | 704 passed in 63 files, plus 55 brand/deployment guards. Final affected component/report-page subset: 47 passed. |
| Browser | Chat attachment, patient creation/details, upload, uncertain findings, independent review and persistence on reopening passed at 375×812 and 1280×800. Axe, reflow and 44px save control checked. Existing report loading/focus/error interactions also passed (4 combined cases). Final compact presentation and patient-filtered history selection each rechecked (2 cases each). Screenshots visually inspected; both owned stacks torn down. |
| Workspace `pnpm test` | Exit 0 across packages. Default backend: 2,080 passed, 483 skipped; frontend: 704 passed. Service-dependent acceptance was run separately below. Backend emitted an existing worker-teardown/open-handle warning. |
| Backend memory profile | 3,411 passed, 682 conditional skips. |
| Backend PostgreSQL profile | 4,060 passed, 34 conditional skips. |
| Backend PostgreSQL/S3 profile | Full run: 4,088 passed, 2 pre-existing skips, 1 controller-inventory failure. Registering the new controller in the exhaustive list (26 total, retaining all assertions) passed the affected inventory/API checks. The later checksum-corruption control also passed, bringing that focused run to 85. No production code changed after the full run. |
| Recovery | Both F2 and F3 artifact validators passed across memory, PostgreSQL and PostgreSQL/S3 profiles. |
| Other gates | Typecheck, lint/format, workspace build, frontend bundle/foundation checks, 285 infrastructure guards and 217 CI configuration controls passed. |

The first seven API cases failed at the missing routes (404) before implementation. Three targeted guard-removal controls failed as intended in isolated temporary worktrees: omitting expected-source comparison committed a stale decision; omitting the owned-local policy changed a required 503 to 404; omitting byte-hash comparison returned 200 for corrupted metadata instead of 409. The intact implementation passed all 13 API cases; mutation worktrees were removed. Oversize acceptance uses a valid package padded with legal JSON whitespace so it tests the preview byte limit independently of intake's string bound.

The initial concurrent broad runs hit existing migration/security timeouts and an orphan-process check, then a session interruption stopped those runs before completion; they are not passes. Sequential reruns used a corrected external child-process reaper without changing assertions or deadlines. Those failures did not recur. The infrastructure suite initially stalled on empty subprocess stdin inside the sandbox; a minimal reproduction passed outside it, where the unchanged suite passed.

Synthetic fixtures only; no personal uploaded reports or real identifiers were used. API acceptance uses real migrated PostgreSQL/application roles and versioned Moto S3. Component tests simulate HTTP responses; browser acceptance uses the actual API and test identity provider. Existing engine-dependent suites use their established test stand-ins where permitted; five absent-reader-engine specs are explicitly excluded in every backend profile, not counted as passes. Later test-only additions were verified in focused runs. These are local working-tree checks; exact-commit hosted CI and clinical approval remain separate.

## Remaining

This is S2a, not all of S2. Laboratory fields are a validated projection of the persisted source, not a normalized finding registry. External accession/revision deduplication, amendment reconciliation, issuer qualification and independent analytic acceptance remain open. S3 must generate contextual assessments from reviewed synthetic rules and connect them to existing clinician decisions/follow-ups. CPIC content review, vendor-PDF extraction and Data Insights authorization remain separate work; no clinical or real-data gate is opened.
