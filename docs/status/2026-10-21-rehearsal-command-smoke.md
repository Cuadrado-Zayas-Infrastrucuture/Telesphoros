# The image rehearsal runs the task commands through the image ENTRYPOINT (local)

Date: 2026-10-21

PR #224 stopped the worker, migration, provisioning and issuer task commands from repeating the image's `node` ENTRYPOINT, and a text guard keeps it so. The image rehearsal (`infrastructure/docker/rehearsal.cjs`) could not have caught the original bug: its driver starts the worker and the CLI with `spawn(process.execPath, [...])` from inside the container, which skips the ENTRYPOINT. The rehearsal now begins with `infrastructure/docker/command-smoke.cjs`: it reads every `command` that Terraform gives a container of the API image (with the same code as the guard, now shared in `infrastructure/terraform/entrypoint.mjs`) and runs each as `docker run --rm --network none IMAGE <command...>`, which is what ECS does. With no configuration each process refuses to start and exits; the smoke fails only if Node reports that it could not find the module, if it finds fewer than four commands, or if docker itself fails. Output is never printed.

Checked on an image built from the Dockerfile: the four real commands pass; the old `node`-prefixed commands fail with the module-not-found error. The stand-in tests in `entrypoint.guard.test.mjs` (run by `pnpm test:infra`) cover the failing cases and the order of the call in `rehearsal.cjs`. Not verified: the full rehearsal (Postgres, Moto, the linux/amd64 archive image) was not run locally; the smoke runs there for the first time in the image job. ECS itself is still unverified until the first real apply.

Local only: nothing is pushed.
