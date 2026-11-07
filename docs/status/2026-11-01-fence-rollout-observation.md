# Read-only medication fence rollout observations

Date: 2026-11-01

An offline checker can compare a reviewed staging API task definition/image with complete ECS service and running/stopped task snapshots. It holds on mixed revisions, enabled/overridden write settings, incomplete inventories, transitioning tasks and stale observations. Output contains aggregate counts and fixed reasons, never raw environment values.

It performs no AWS reads or writes and makes no request-drain or release-approval claim. It is independent of the pending application-fence PR #253. See the [input contract and limits](../ops/medication-fence-rollout-check.md) and [verification](../verification/fence-rollout-observation.md).

ISMP integration remains deferred by founder decision until an official email response and its written scope have been reviewed. The account-download attachments remain local and outside the product/public repository.
