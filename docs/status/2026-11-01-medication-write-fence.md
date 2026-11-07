# Default-closed medication recording

Date: 2026-11-01

Medication POSTs now require explicit `MEDICATION_WRITES=enabled`; otherwise they return a fixed pause response without reserving a request id or appending a medication row/event. Authorized history remains readable, and the compact form keeps values/retry identity. Terraform's setting also defaults closed; local synthetic capture profiles explicitly open it.

The historical-ingredient path also rechecks replay before returning a stale-version conflict, fixing a concurrent identical-retry window exposed by the existing four-request regression. No test assertion was weakened.

See the [fence contract and release limits](../ops/medication-write-fence.md) and [verification](../verification/medication-write-fence.md). This per-process setting does not establish a global drain, live rollout or migration approval. Existing release-shape guards remain intact; a configuration/cutover path and real operational rehearsal remain outstanding.
