# The CI process-list parser accepts a negative user id on macOS

Date: 2026-11-10

`parseDarwinProcesses` in `.github/ci/service-deadline.mjs` reads the `ps` process list on macOS and refused the whole list when any line did not match. Its pattern took the user id as digits only, but macOS prints the unprivileged `nobody` account as `-2`. Whenever such a system process was running on a workstation, twelve tests in `pnpm test:ci-config` failed with "Service budget validation failed", whatever the branch.

The pattern now accepts a negative user id. The process id and parent id must still be positive, and any other malformed line is still refused. A process owned by `nobody` is kept in the table with its own user id, so it is never taken for one of the caller's processes. The copy of the script embedded in `.github/workflows/ci.yml` carries the same change, as the layout check requires.

Hosted CI runs on Linux and does not use this parser, so nothing changes there.
