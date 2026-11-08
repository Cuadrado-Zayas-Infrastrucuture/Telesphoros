# Real knowledge files need two signers' signatures to load under the production rules

Date: 2026-11-08

Before this, a reviewed knowledge file named its reviewer and carried a content hash, and anyone who could edit the file could rewrite both. Schema 1.3 now lets `review.signatures` carry ECDSA P-256 signatures over the file id and its content hash. Under the production rules the loader accepts a real reviewed file only with valid signatures from two distinct signers listed in `KNOWLEDGE_SIGNER_KEYS`, which is set where the process runs, not in the repository.

`knowledge:sign` signs through KMS and checks the result against the key's public key before printing the entry. It writes nothing. Each citation from a signed file records `signedBy` inside the ledger hash; unsigned citations keep their exact shape. What a guideline signs as `notCovered` is part of the signed content.

Not done: nothing has been signed with a real key, since the KMS keys are a separate Terraform change the founder applies. Non-production loads and synthetic knowledge need no signature. See [cpic-integration.md](../cpic-integration.md#review-and-sign-off).
