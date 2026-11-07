# Reviewed same-image medication recording transitions

Date: 2026-11-01

Separate FENCE-CLOSE/FENCE-OPEN release modes change only the medication-write setting and API service revision, keeping the image and other configuration fixed. They retain existing release guards, archive each operation, bind source/target variable hashes, and require completed coordinated-release evidence before opening. Failed applies do not publish target variables as canonical.

A local real-PostgreSQL/HTTP rehearsal demonstrates that a request admitted by an old enabled API can commit while disabled replacements refuse new requests. This is drain-boundary evidence, not an AWS/global-drain claim. Malformed private plan JSON now emits a fixed refusal without echoing contents.

See the [transition procedure](../ops/medication-fence-transitions.md) and [verification](../verification/fence-transitions.md). No live plan/apply, migration, deployment or ISMP integration occurred.
