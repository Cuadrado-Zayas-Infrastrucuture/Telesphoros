# Verification: an alarm for failed worker signatures at the session issuer

Date: 2026-10-29

Scope: the `issuer_worker_unauthenticated` metric filter and alarm in `infrastructure/terraform/issuer.tf`, and the checks added to `issuer.guard.test.mjs`. Terraform text only. Nothing is planned or applied.

## Seen failing

The filter's phrase was changed in the real `issuer.tf` to `Issuer request rejected`. The guard then failed with "the worker-signature filter must match the issuer server's unauthenticated phrase". The file was restored byte for byte.

The guard's own controls weaken the text five ways and check that each is reported: the phrase, the threshold, the topic, the missing-data rule, and the server's log line. The control for the unavailable alarm's threshold now names that alarm's filter, because `threshold = 5` occurs twice.

## Results

| Run                                                                         | Result     |
| --------------------------------------------------------------------------- | ---------- |
| `node --test infrastructure/terraform/issuer.guard.test.mjs`                | 4 passed   |
| `tofu fmt -check` on `issuer.tf` (CI runs `terraform fmt`, the same format) | clean      |
| `pnpm test:infra`, after `pnpm build`                                       | 150 passed |

The first `test:infra` run in this worktree failed one file, `guard.test.mjs`, because `@telesphoros/shared-types` had not been built there yet. The full loop builds first. After `pnpm build`, all 150 passed.

## Not verified

- **No plan or apply.** No deployment has the issuer's worker route enabled.
- **The pattern against real issuer logs.** The filter's text is checked against the server's source, not against CloudWatch.
