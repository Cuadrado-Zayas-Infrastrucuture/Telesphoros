# Observe medication-write settings across API tasks

Date: 2026-11-01. This is an offline, read-only observation checker, independent of the application fence proposed in [PR #253](https://github.com/Cuadrado-Zayas-Infrastrucuture/Telesphoros/pull/253). It calls no AWS API and changes no setting, task, database, plan or deployment.

```sh
node scripts/staging/check-medication-fence-rollout.mjs /private/path/observation.json
```

The output contains only a fixed status, running-task count and fixed reason codes. Exit 0 means **observed-disabled**: the supplied snapshot shows the explicit disabled environment setting on one reviewed API task definition, matching healthy running tasks, a completed single deployment and consistent inventories. Exit 1 means **hold**, including unknown/missing/malformed data. Neither result establishes request draining, blocked POST behavior or release approval. An old binary could ignore the environment setting: verify the pinned artifact contains the fence and independently probe its behavior with authorized synthetic requests.

## Input contract and collection

Supply a private JSON object with these keys. It contains raw ECS data and may contain environment/secrets references; keep it out of the public repository and public logs. No patient data is needed.

| Key | Content |
| --- | --- |
| `capturedAt` | Actual UTC observation time ending in Z. Older than five minutes or more than 30 seconds in the future holds. This caller-supplied timestamp is not authenticated freshness proof. |
| `expected` | Reviewed `accountId`, `clusterArn`, `serviceArn`, `taskDefinitionArn` and digest-pinned ECR `image`. Target is the existing us-east-2 synthetic staging API names. These expectations must come from the authorized release packet, not be copied from an unexpected running task to make it pass. |
| `services` | Complete `describe-services` response for that one service, including its `failures` array. |
| `runningTaskArns` | Complete `list-tasks` response for that service with **desired status RUNNING**. |
| `stoppedTaskArns` | Complete `list-tasks` response for that service with **desired status STOPPED**. Include the recently stopped inventory: a task can still be stopping after it disappears from the RUNNING-desired-status list. |
| `tasks` | Combined complete `describe-tasks` results for the union of both inventories, including an explicit `failures` array. Collect all batches, reject any failure, and retain every returned task. |
| `taskDefinition` | `describe-task-definition` response for the exact reviewed task-definition ARN. |

The collector/operator must establish the live AWS identity/account, use the same cluster/service throughout, exhaust pagination, inspect every failed read and record the observation window. The checker refuses unconsumed pagination and missing/extra/duplicate described tasks; it cannot discover a deliberately omitted inventory page or authenticate the origin of a file. AWS reads across multiple calls are not atomic: refresh the entire packet if tasks change during collection. No live collection was performed while preparing this helper.

The expected definition must explicitly set `MEDICATION_WRITES=disabled`. Absence is a hold even if a newer application defaults disabled. Duplicate settings, a secret of the same name, environment files, runtime flag overrides and runtime command overrides hold. All non-stopped tasks must match the expected revision and digest and report healthy RUNNING state. STOPPING/DEPROVISIONING tasks hold; fully STOPPED tasks from the stopped inventory are accounted for without counting them as serving capacity. Missing health, pending capacity, multiple/incomplete deployments and zero serving capacity also hold.

## What remains before claiming a fence

This checker covers only the supplied ECS configuration observations. It does not measure load-balancer deregistration, already admitted HTTP requests, active database transactions, standalone/import writers, worker/verifier compatibility, migrations, signatures or tenant/role behavior. It does not approve changing the flag or add a configuration-only mode to the release scripts. Preserve the existing identity, exclusive-claim, saved-plan/hash/state and shape guards. Review and rehearse the flag transition and global maintenance/drain procedure separately before live use; a zero exit here cannot substitute for that evidence.
