# Chore: the report-reader engine is optional (local)

Date: 2026-10-23

Step toward making the repository public: the imported reader engine (`knowledge/lab-report-reader/`, 123 files with twelve development PDFs and the engine) and the one-file Python wrapper (`sidecars/report-reader/`) must be removable. Before this change a checkout without them failed 21 backend spec files, and nothing said why.

Measured, not guessed: all three backend tiers were run with both directories renamed away. 21 spec files failed (the rest of the 199 suites, and every non-reader behaviour, passed). Six of the 21 hold some tests that pass without the engine (`subprocess-report-reader`, `fake-text-capture-runner`, `lab-reports-capture`, `reports-intake-organization`, `patient-merge`, `lab-pdf-reports`); they are skipped whole for now.

Changed: `jest.config.js` skips the listed specs when the engine is absent and announces it; `engine-presence.ts` makes a pipeline switched on without the engine stop the start with the missing paths in the message (before, the first read failed with a spawn error); `reader-engine.spec.ts` is the guard (list names only existing files, jest paths equal the code's paths, any spec naming the engine paths or fixture helpers is listed or explained); `scripts/check-without-reader.sh` runs the suite with the directories really removed, and `--measure` compares the list with a real run.

Not changed: the engine and fixtures themselves (they are still here, and still pinned), the pipeline's default (off), the production refusal, the port and wrapper code. Fresh public fixtures and a stand-in reader that let the six partly-skipped files run without the engine are the follow-up. Filtering the engine out of the published history is a separate step (a fresh repository from a filtered export).

Local only until the pull request is opened.
