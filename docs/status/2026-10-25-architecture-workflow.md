# Adopt an exploratory architecture workflow

Date: 2026-10-25

Adopted `telesphoros-improve-architecture` from the pinned Matt Pocock reference copy. It scans a bounded codebase/subsystem, records source/history evidence and presents candidates in a static HTML report. Selected-module interface design and specific-diff review retain their existing workflows. This adoption performs no architecture audit or refactor.

The adaptation works linearly, accepts zero supported candidates, retains independent database/security evidence and surfaces ADR conflicts without changing decisions. Source text is escaped; the report needs no CDN, installer, automatic OS browser launch or unavailable interview skill. The pinned upstream source remains unchanged.

Routing evaluation: the previous 48/48 cases remain unchanged and passing; all eight frozen new cases pass on the first candidate (56/56 total). This is lexical routing evidence, not a model-behavior guarantee. Two manual scenario rubrics cover bounded/no-candidate outcomes and source/ADR boundaries.

An escaped synthetic artifact was checked at 728px and 360px, with two columns and one column respectively, no overflow, resource requests or source execution. The first preview harness counted T3's injected theme script; the corrected assertion distinguishes that host script from the artifact, whose static parser confirms zero scripts or active links. This checks the example artifact, not all future generated reports.

All seven required local checks passed: typecheck, lint, tests, build, infrastructure tests (144/144), CI-config tests (203/203) and workflow checks (56/56 routing; 5/5 checker tests). The skill validator, local links/anchor checks and redacted candidate secret scan passed; unknown-skill, missing-case and broken-link controls failed as expected. Database/S3 acceptance remains outside this documentation-only change; default skipped service tiers cannot establish acceptance.
