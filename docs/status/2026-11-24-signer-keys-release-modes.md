# Release modes for the knowledge signers' public keys (033-23 H1)

Date: 2026-11-24

The staging release recipe can now give the API task the knowledge signers' public keys, and take them away again. Before this, no release mode
could. `knowledge_signer_keys_on_api` (#438) adds `KNOWLEDGE_SIGNER_KEYS` to the API task definition, and:

- an INFRA plan never changes a task definition;
- an IMAGE plan cannot flip the switch, because its var file may differ from `current.tfvars` by the two image lines only;
- the MIGRATE plan before it would also replace the API task definition, which MIGRATE refuses.

So the runbook's "turn it on in the next IMAGE release" could not work.

There are two new one-flag modes:

- `SIGNER-KEYS-ON` changes that one variable and nothing else, and keeps the running image. It replaces only the API task definition and moves its service in place. The only setting it may add is `KNOWLEDGE_SIGNER_KEYS`, and that must hold exactly one distinct public key PEM per signer the plan's `knowledge_signers` names, at least two.
- `SIGNER-KEYS-OFF` removes the setting. As the way back, it accepts any well-formed keys, whatever signers are named now.

The founder chose the gate on 2026-11-24 ("Approve, same gate"). `SIGNER-KEYS-ON` waits for the release now running to be finished: its IMAGE apply, its migrations, and a verification record for the running image, either a signature or a break-glass record with a written reason, as for `ASSESSMENT-ON`. `SIGNER-KEYS-OFF` waits for nothing. Evidence goes under `releases/COMMIT/signer-keys/OPERATION_ID/`.

`verify.sh SIGNER-KEYS-ON|SIGNER-KEYS-OFF COMMIT OPERATION_ID` adds check 7. When `current.tfvars` switches the keys on, it reads each signer's key ARN from `terraform output knowledge_signer_key_arns` and that key's public half from KMS (`kms get-public-key`, read-only). Each must equal the key the running API task carries for that signer. When the keys are switched off, the setting must be absent. No key is printed.

What changed:

- **The one-flag engine:** `fence-vars.mjs`, `fence-plan.mjs`, `release-check.mjs`, `lib.sh` (the new `flag_allows_break_glass` replaces the two `ASSESSMENT-ON` special cases), `plan.sh`, `apply.sh` and `verify.sh`.
- **Text:** the wrong rollout text in `knowledge-signing.tf` and `docs/ops/knowledge-signing.md` (step 4), and the mode list in `docs/ops/staging-release.md`.
- **Guard:** `knowledge-signing.guard.test.mjs` now checks that the modes name the switch and the setting Terraform has.

Verification, Node 22.23.5, in the sealed sandbox:

- `signer-keys-plan.test.mjs`: 84 of 84 (new). It was red first, on the missing export.
- `release-scripts.test.mjs`: 9 of 9 (was 8; the new test runs the real `plan.sh` and `apply.sh` against stubs).
- `release-after.test.mjs`: 9 of 9 (was 8; the new test runs the real `verify.sh` against stubbed Terraform and KMS).
- `test:infra`: 569 of 569. `test:ci-config`: 251 of 251.
- 18 deliberate breaks of the new code each failed a named test.

Not done: no plan, apply or verification against staging, so none of this is proved on a real Terraform plan or a real KMS answer. The offline
tests use invented plan JSON, invented keys and stubbed Terraform and AWS. On staging, `knowledge_signers` is not set yet. That is an INFRA edit
and re-hash of `current.tfvars`, then an INFRA plan that creates the keys. `SIGNER-KEYS-ON` then needs a release whose commit includes this
change. The founder runs all of it.
