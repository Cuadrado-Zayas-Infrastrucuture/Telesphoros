# Inactive durable evaluation admission

Date: 2026-10-26

H1 adds immutable evaluation requests and an inert completion receipt, a strict requestId-only job definition, and internal admission/status services using the existing PostgreSQL queue. Request and job commit together; retries are caller-scoped and preserve exact source/execution binding. Current database roles, accepted capture and verified patient/file link are checked under the existing decision serialization boundary. No public route, worker consumer, schedule or model is enabled.

The trusted execution profile pins a provider-neutral manifest. Founder direction preserves self-hosted open-weight and Amazon Bedrock options, with in-house AI operation as the long-term target. H1 adds no provider adapter or call; future execution must resolve the exact pinned profile and retain model-change evaluations, human review and clinical holds.

Migration 0050 is marked breaking under current lint because it protects new append-only tables against TRUNCATE. Existing clinical records, synchronous evaluation, production consumers and permissions remain unchanged. The down migration refuses durable work/history rather than discarding it. No live migration or deployment is authorized.

Real-PG focused controls exercise atomic replay/rollback, lost COMMIT response, review/link races, role/tenant refusal, source/profile binding, immutable metadata and receipt/status consistency. Queue success without a receipt never becomes clinical success. Broader required local/service/recovery and hosted acceptance are recorded separately in the delivery evidence. [Design](../design/plans/engine-durable-admission.md) and [verification](../verification/engine-durable-admission.md).
