# CI: every dependency cache is keyed by the file that decides it (local)

Date: 2026-10-22

Audit of the caches in `ci.yml`: the pnpm store (setup-node) and pip downloads (setup-python) were already keyed by their dependency files, the Playwright browser by its installed version, the Docker layers by content. The Go build cache for gitleaks was keyed by the hash of the whole `ci.yml`, so every workflow edit discarded it. It is now keyed by `.github/ci/gitleaks.version`, a one-line file that a guard keeps equal to the install command and the step name. The pnpm cache path is now explicit (`pnpm-lock.yaml`) on all six jobs and guarded, with the pip one, against drifting to a workflow file, a commit or a run value.

Interaction to know: with tree reuse a push to `main` no longer saves the pnpm and Playwright caches, and a pull request can read only caches written on `main` or on itself. The nightly keeps the `main` caches warm; after a lockfile change merges, pull requests install cold until the next nightly. Not measured: no hosted run is possible until the minutes reset.

Local only: nothing is pushed.
