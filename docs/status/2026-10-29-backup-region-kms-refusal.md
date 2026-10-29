# Found: the backups KMS key cannot be created outside the primary region in the founder's account

Date: 2026-10-29

Follows `2026-10-29-s3-backups-key-check.md`, which found `us-east-1` (the default `backup_region`) refusing `kms:CreateKey`.

- A founder-approved probe created nothing: one tagged throwaway key, as Terraform's `default_tags` would create it, was refused in `us-west-2` by an explicit deny in a service control policy. Only `us-east-2`, the primary region, allowed it.
- So moving the `backup_region` default would not help. Which region may hold the backups key is set by the organization's policies and belongs to decision D1. The default is unchanged.
- `docs/ops/offsite-backups.md` and `docs/verification/s3-default-key-check.md` say so. Unproven for the role that will apply Terraform; no apply was attempted.
