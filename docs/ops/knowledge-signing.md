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

## Each signer's own sign-in (synthetic staging)

A signer key may be used by one IAM principal only, and the account's administration role is shared by design, so each signer first needs an identity
that is theirs alone. `infrastructure/terraform/knowledge-signer-people.tf` creates one per person named in `knowledge_signer_people`:

- **An IAM user**, `<stack>-signer-<id>`, with no access key, no console password and no MFA device: Terraform never creates those, because each would
  put a secret in the state. The user may change their own password, set up their own MFA device, manage their own access keys and become their own
  signing role. Every other call is denied until the session has MFA.
- **A signing role**, `<stack>-knowledge-signer-<id>`, that only that user can become, with an MFA code at most an hour old, for at most an hour. It
  carries no policy: the key policy of that signer's key is what lets it sign. Its ARN is what `knowledge_signers` names for that id.
- **Synthetic staging only.** The plan refuses `knowledge_signer_people` in production, where signers sign in through IAM Identity Center. IAM is free.

The founder runs these steps; an agent only prepares them.

1. **Name the people** with the same ids they will sign under: `knowledge_signer_people = ["jan", "kevin"]`. This is an INFRA plan (users, roles and
   their policies; no task definition or service), reviewed and applied as in [staging-release.md](staging-release.md). The roles' ARNs are in
   `terraform output knowledge_signer_person_role_arns`.
2. **First console password, by hand.** In the IAM console, for each user: enable console access with a custom password that must be changed at the
   first sign-in, and hand it to that person in person. It is never written to the repository, chat or email.
3. **Each person, in their first session:** change the password, assign a virtual MFA device to their own user, then create their own access key.
4. **Each person's CLI profile** takes on the signing role with MFA (the source profile holds their own access key):
   ```ini
   [profile <id>-signer]
   role_arn       = <their signing role ARN>
   source_profile = <id>-user
   mfa_serial     = <their MFA device ARN>
   duration_seconds = 3600
   ```
   `aws sts get-caller-identity --profile <id>-signer` asks for the MFA code and shows the signing role.

**The keys themselves are the next step, in two releases.** Once each person can take on their signing role, name the signers in
`knowledge_signers` with those roles' ARNs: an INFRA plan creates the keys and leaves the API task alone, and the next IMAGE release turns on
`knowledge_signer_keys_on_api` so the API receives `KNOWLEDGE_SIGNER_KEYS` (steps below).

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
