# Tasks: knowledge identifiers

| Task | Owner | Exit condition |
| --- | --- | --- |
| T1 | Founder | Approves this spec, plan and tasks, and decides D1 to D3 (done 2026-11-05) |
| T2 | Maintainer | Schema 1.3 in `cpic-schema` with tests that fail without each rule |
| T3 | Maintainer | Loader refuses a reviewed, non-synthetic 1.2 file in production; test fails without the guard |
| T4 | Maintainer | `synthetic-identifiers` fixture set; the two existing sets byte-identical (checked by hash) |
| T5 | Maintainer | Engine copies identifiers for 1.3 knowledge; 1.2 results unchanged against independently written expected values |
| T6 | Maintainer | Migration 0071 up and down on PostgreSQL 16; constraints and the down refusal tested |
| T7 | Maintainer | Repository writes the columns; projection includes them only when present; a 1.2 evaluation's projection pinned unchanged; ledger walk clean |
| T8 | Maintainer | Docs: `cpic-integration.md` 1.3 section, clinical-validation note, one status fragment |
| T9 | Maintainer, then founder | Every tier run locally with counts; gitleaks clean; founder commits; draft pull request opened only after the founder says "push" |
| T10 | Founder, with counsel | Before any real identifier: confirm CPIC's drug, gene and allele identifier fields at source and close R13. Not part of this pull request |
