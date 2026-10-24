# verify-image compares the KMS key ARN as text (2026-10-23)

Date: 2026-10-23

**Implemented.** CodeQL alert 16 (`js/regex-injection`, high) on `scripts/staging/verify-image.mjs`: the check that the signing key's ARN belongs to the image's account and Region built a `RegExp` from those two values. They cannot hold a pattern character (the image reference must match `ECR_IMAGE` first: 12 digits and `[a-z0-9-]+`), so this was a false positive today, but the gate then depended on a check made lines earlier. It now compares a fixed prefix (`arn:aws:kms:<region>:<account>:key/`) as text and requires the rest to be a lowercase key id. Behaviour is unchanged: the existing refusal cases and four new ones (path after the key id, uppercase key id, the expected ARN only a part of the answer, no ARN) behave the same on the old and the new code, and a version without the prefix check fails the new cases.

**Not established.** Whether CodeQL closes the alert is known only after its analysis of the pull request. Nothing observed in AWS; the script was run against stubs only.
