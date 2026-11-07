# Knowledge signing keys

Audit CLIN-01. Under the production rules, a real reviewed knowledge file loads only with valid signatures from **two distinct signers**. The public keys of those signers must be in `KNOWLEDGE_SIGNER_KEYS` (format and checks: [cpic-integration.md](../cpic-integration.md#review-and-sign-off)).

This runbook creates one KMS key per signer and gives the API their public keys. **The founder runs it: an agent only prepares it.**

## What it creates (`infrastructure/terraform/knowledge-signing.tf`)

- **Keys:** one asymmetric KMS key per named signer: `ECC_NIST_P256`, `SIGN_VERIFY`, alias `alias/<name>-knowledge-signer-<id>`.
- **Who can sign:** the key policy denies `kms:Sign` to every principal except that signer's role or user. Account administration stays with the account root, as for every key here.
- **What the API gets:** `KNOWLEDGE_SIGNER_KEYS` on the API task, built from the keys' public halves. It is not a secret.
- **Nothing by default:** with `knowledge_signers` empty, nothing is created and the variable is absent, so the API refuses any signed real file.
- **Cost:** about **$1 per key per month**, so **about $2/month** for two signers. Signing is a few KMS requests per released file.

## Steps

1. **Name the signers** in the environment's variables. Use two different people, each with their own IAM role or user:
   ```hcl
   knowledge_signers = {
     "signer-one" = "arn:aws:iam::<account>:role/<first signer's role>"
     "signer-two" = "arn:aws:iam::<account>:role/<second signer's role>"
   }
   ```
   The plan refuses fewer than two signers, more than twenty, and one principal for two signers.
2. **Review the plan:** two keys, two aliases, and one environment change on the API task. Then apply, as for any change in [deployment.md](deployment.md).
3. **Look up the key ARNs** with `terraform output knowledge_signer_key_arns`. Each signer uses only their own.
4. **To sign a file**, each signer runs this with their own AWS credentials, from `apps/backend` after `pnpm build`:
   `pnpm --filter @telesphoros/backend knowledge:sign -- <file> --key-id <their id> --kms-key <their ARN>`
   Then they add the printed entry to the file's `review.signatures`. The command checks the signature against the key's public key before printing anything, and writes nothing itself.
5. **Check before release:** `knowledge:verify --production`, with the same `KNOWLEDGE_SIGNER_KEYS` the task has, must pass.

## Rotation and loss

KMS cannot rotate an asymmetric key. To rotate a signer, or at once if a key may be misused:

1. Add a new id with a new key.
2. Re-sign the released files with it.
3. Remove the old id. Removing it from `KNOWLEDGE_SIGNER_KEYS` makes every file signed only by that key fail to load, which is the intended effect.
