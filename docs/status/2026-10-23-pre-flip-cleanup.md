# Pre-flip cleanup: working notes untracked, local paths removed, required-checks count fixed (local)

Date: 2026-10-23

From the pre-flip hygiene scan. `work/` (two files of session notes with local paths) is untracked and listed in `.gitignore`; the files stay on disk where they were and nothing in the repository, its tests or CI read them. Ten lines in seven `docs/verification` files named absolute paths on the author's machine (`/Users/<name>/...`) for raw logs, screenshots and JSON captures. Those files were never in the repository (`packages/smart-pilot/.gitignore` excludes `.runtime/`), so the links were dead for anyone else. The prefix is now `<task workspace>`, meaning the local folder where the verification run was done, and the dead markdown links are plain text; no file name or fact was removed. `docs/architecture.md` said CI runs five required checks; the repository ruleset requires six, and `image` is added to the list.

Verified: no `/Users/` path remains in `docs/verification`, `work/` is no longer tracked, and `test:infra` and `test:ci-config` pass. Not changed: the eight reader import files under `knowledge/lab-report-reader` that also contain local paths (hash-checked imports, which follow the reader decision), product code and CI.

Local only until the pull request is opened.
