# Tasks: Clinical review before a release (spec 044)

| Task | Owner | Exit condition | State |
| --- | --- | --- | --- |
| T1 | Founder | Chooses the release gate and approves the plan, with the staging exception (D3) | Done 2026-11-19 |
| T2 | Maintainer | `clinical-review.test.mjs` (T-1 to T-10, and the command) and the image-step test written, and seen to fail before the code | Done: the new module's tests could not load; 8 image and migrate tests failed without it |
| T3 | Maintainer | `clinical-review.mjs` and the `image.sh` gate; the tests pass | Done: 12 of 12 and 11 of 11 |
| T4 | Maintainer | Each check broken once, its test seen red, then restored | Done: 14 breakages, all red; 23 of 23 after restoring |
| T5 | Maintainer | `staging-release.md` steps 4 and 7, `docs/ops/clinical-reviews/`; full local loop; gitleaks | See the pull request |
| T6 | Founder | Names the signers (`knowledge_signers`, Kevin's IAM principal) and applies INFRA, so Kevin has a KMS key; until then a clinical change goes out only by the exception | Open |
| T7 | Founder | The first release through the gate; its record in the facts pull request | Open |
