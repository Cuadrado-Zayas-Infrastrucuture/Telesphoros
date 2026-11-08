# Terraform can create one KMS signing key per knowledge signer

Date: 2026-11-08

`infrastructure/terraform/knowledge-signing.tf` adds `knowledge_signers`, a map from each signer id to the one IAM principal allowed to sign with that signer's key. It is empty by default, which creates nothing.

Once signers are named, each gets an asymmetric KMS key (`ECC_NIST_P256`, `SIGN_VERIFY`) whose key policy denies `kms:Sign` to every principal except that signer, and the API task receives `KNOWLEDGE_SIGNER_KEYS`, built from the keys' public halves. Two keys cost about $2 a month. The plan refuses fewer than two signers and one principal holding two signers. The steps are in [knowledge-signing.md](../ops/knowledge-signing.md).

Not done: nothing is applied; the founder applies it. `terraform validate`, `terraform test` and a real plan were not run locally.
