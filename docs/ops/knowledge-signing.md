# Knowledge signing keys

Audit CLIN-01. Under the production rules, a real reviewed knowledge file loads only with valid signatures from **two distinct signers**. The public keys of those signers must be in `KNOWLEDGE_SIGNER_KEYS` (format and checks: [cpic-integration.md](../cpic-integration.md#review-and-sign-off)).

This runbook creates one KMS key per signer and gives the API their public keys. **The founder runs it: an agent only prepares it.**

## What it creates (`infrastructure/terraform/knowledge-signing.tf`)

- **Keys:** one asymmetric KMS key per named signer: `ECC_NIST_P256`, `SIGN_VERIFY`, alias `alias/<name>-knowledge-signer-<id>`.
- **Who can sign:** the key policy denies `kms:Sign` to every principal except that signer's role or user. Account administration stays with the account root, as for every key here.
- **What the API gets:** `KNOWLEDGE_SIGNER_KEYS` on the API task, built from the keys' public halves, once `knowledge_signer_keys_on_api` is on. It is not a secret.
- **Two releases, not one:** an INFRA plan may create the keys but never changes a task definition, and an IMAGE plan replaces the task definitions but never creates a key (`scripts/staging/release/release-check.mjs`). So the keys go out first with the switch off, and the switch goes on in the next IMAGE release.
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
   **Each id is that signer's handle**, the short name they sign reviews under, and it is the same everywhere: here, in `KNOWLEDGE_SIGNER_KEYS`, and as `--key-id` when they sign. A file whose signatures use any other id is refused before release.
2. **Review the plan:** an INFRA plan with two keys and two aliases, and no task definition or service change (`knowledge_signer_keys_on_api` stays off). Then apply, as for any change in [deployment.md](deployment.md) and [staging-release.md](staging-release.md).
3. **Look up the key ARNs** with `terraform output knowledge_signer_key_arns`. Each signer uses only their own. The keys can sign from now on (for example a clinical release review); the API does not yet accept signed real files.
4. **Give the API the public keys** in the next IMAGE release: set `knowledge_signer_keys_on_api = true` in the same variables. That release's new API task definition carries `KNOWLEDGE_SIGNER_KEYS`; the plan refuses the switch while no signer is named.
5. **To sign a file**, each signer runs this with their own AWS credentials, from `apps/backend` after `pnpm build`:
   `pnpm --filter @telesphoros/backend knowledge:sign -- <file> --key-id <their id> --kms-key <their ARN>`
   Then they add the printed entry to the file's `review.signatures`. The command checks the signature against the key's public key before printing anything, and writes nothing itself.
6. **Check before release:** `knowledge:verify --production`, with the same `KNOWLEDGE_SIGNER_KEYS` the task has, must pass.

## Rotation and loss

KMS cannot rotate an asymmetric key, and a signer keeps their id because it is their handle. To rotate a signer's key, or at once if a key may be misused:

1. Plan and apply a replacement of that signer's key only (`-replace='aws_kms_key.knowledge_signer["<id>"]'`), as for any change in [deployment.md](deployment.md). The old key is scheduled for deletion, and the API gets the new public key under the same id.
2. From then on, every file that signer signed fails to load until it is signed again, which is the intended effect.
3. Re-sign those files with the new key (step 4) and release them.
