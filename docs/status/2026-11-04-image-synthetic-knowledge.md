# The API image carries the synthetic knowledge (032 S3, PR 3c-1)

Date: 2026-11-04

The API image now carries the synthetic knowledge of the structured assessment, so the release can set `SYNTHETIC_KNOWLEDGE_DIR` to a directory that exists. Until now the build context excluded `data/` and the image held none of it, so a staging task with the switch on would have stopped at start for a missing directory (fail closed, but the release would have broken). Nothing reads the directory unless `SYNTHETIC_ASSESSMENT` is enabled, and nothing sets that yet.

What changed: `.dockerignore` re-includes exactly `data/fixtures/knowledge/synthetic-structured` under the excluded `data/`; `api.Dockerfile` copies it to `/app/synthetic-knowledge` in the runtime stage; `infrastructure/docker/guard.test.mjs` pins both (the exclusion of `data`, exactly one `!data` exception, exactly one `COPY` from `data/`, in the runtime stage) with mutation cases; the image rehearsal runs a new `synthetic-knowledge-smoke.cjs` inside the built image, which loads the directory with the application's own loader and fails if it is missing, holds other guidelines, or holds a file that does not say it is synthetic. `docs/ops/image-push.md` says what the image carries from `data/`.

Verification, Node 22.22.0: `node --test infrastructure/docker/guard.test.mjs` 43 of 43 (the new rules and nine new mutation cases among them); the smoke script run against a local image-like layout passes with the real set and exits 1 for a missing directory and for the non-synthetic base set; `test:infra` 300 of 300 and `test:ci-config` 221 of 221.

Not done: **the image was not built here**: there is no Docker engine on this machine, so whether Docker honours the `!data/...` exception for a path under an excluded directory is proved only by the hosted `image` job (its rehearsal runs the smoke script in the built image). If that job fails on the smoke step, the exception did not work and the fallback is moving the folder under `apps/backend/`. No Terraform, release or frontend change; 3c-2 (the Terraform switch) and 3c-3 (the release) follow.
