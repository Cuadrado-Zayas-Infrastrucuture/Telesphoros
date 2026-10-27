# H1: inactive durable evaluation admission

Date: 2026-10-26

H1 is the approved first foundation of product-engine orchestration. It stores an immutable evaluation request and one existing PostgreSQL queue job in the same transaction, supports a safe retry identity, and provides internal status reads. It performs no evaluation and has no runtime API or worker registration.

## Ownership and source

The organization owns admitted work; the requester remains provenance. Admission requires current clinician/reviewer membership, an uploaded lab PDF, its capture, the current acceptance, and a current verified patient/file link. Reads require current clinical-read membership. Database membership supplies authority; caller-supplied role arrays cannot grant it.

The request binds the report/capture/acceptance, patient-link decision, exact report hash/object version, captured-text identity and trusted execution profile. No report text, patient label, bearer token or signed URL belongs in a job or request. Only the durable `requestId` goes in the job payload.

`Database.withTenant` owns the transaction. Caller-scoped advisory locking and a unique constraint serialize retry identities. Identical eligible retries return the same request/job; changed source or execution binding refuses. The same client calls existing `enqueueJob` and inserts the request, so a failure rolls both back. Eligibility is rechecked even for a retry; status remains the way to read a historical request after its source becomes stale.

The report is locked SHARE before the tenant ledger head. A narrow definer helper, owned by the existing ledger owner, locks only the transaction's active tenant and checks containment. The source-basis function otherwise runs with application permissions and forced RLS. Fresh capture/link decisions are read after the ledger lock, matching their serialization boundary. No general ledger-write or clinical-worker grant is added.

## Provider flexibility and the in-house target

Founder direction: retain the ability to use self-hosted open-weight inference or Amazon Bedrock, with an AI system operated in-house as the long-term target. Telesphoros retains orchestration, evidence, authority, deterministic clinical rules, human review and evaluation controls.

H1 pins a versioned, trusted profile with `codeArtifactSha256`, `executionManifestSha256`, `knowledgeSetId` and `recordingsSha256`. Applicable reader/model/backend/template/decoding/output-schema identities belong in the immutable execution manifest. A future executor must resolve that exact manifest and supported artifacts; it must refuse unavailable/unsupported profiles rather than silently switch provider, weights or versions. No client-selected provider or model settings enter admission or the queue.

The explanation harness already has [`ModelPort`](../../../apps/ai-service/src/model-clients/port.ts). Future self-hosted and Bedrock adapters should use that boundary with truthful, versioned identity/usage contracts. Its current identity schema needs an explicit extension for self-hosted invocation; H1 does not change or invoke it. Bedrock remains an available managed adapter, rather than an architectural dependency of the product queue. Every future prompt/model/decoding change still requires the approved evaluation suite and before/after results. This decision enables no model call, SDK, provider, cloud spend or clinical release.

## Status and inactive completion

Status checks the tenant, job type/payload, requester and idempotency binding. Queued/running/retry/dead remain operational states. A succeeded queue job without a completion receipt is `completion-missing`, not a clinical success or hold. A receipt must reference an evaluation matching the request's source context; a mismatched receipt fails closed. Receipt-backed completion can precede queue ACK.

The receipt table has no runtime INSERT grant in H1. Actual clinical execution, stale-claim fencing and receipt writing belong to H3, through the existing evaluation/ledger owner. Test-only owner fixtures exercise future receipt reads without adding an application writer.

## Migration and delivery boundary

Migration 0050 creates new objects and leaves existing clinical records and projections unchanged. It is conservatively labelled `breaking` because append-only TRUNCATE guards fail the existing expand lint. Older images do not tolerate a newer breaking history; this is not permission to apply it to a running environment.

The new foreign keys explicitly restrict deletion. The migration grants only the migration login the queue-key REFERENCES privilege, and grants the existing membership-lock function owner its identity-accessor dependencies. No application or worker privilege on an existing table is broadened.

The down migration locks its new tables before inspecting them, temporarily lifts forced RLS as their owner inside the migration transaction, and refuses nonempty request/receipt data. A refusal restores forced RLS through rollback. It checks orphan evaluation jobs under the existing queue owner and its all-row policy, with a SHARE lock preventing concurrent enqueue. Empty rollback works for the actual non-superuser migration login; nonempty work has no bypass setting. No destructive recovery or live migration is authorized.

`EvaluationRequestsService` is constructed only by controlled tests. It is absent from Nest modules/controllers. `evaluations.request` is absent from `PRODUCTION_JOBS`, worker consumers, schedules and outbox routes. Public synchronous evaluation, fixed demo, clinical rules, model clients, infrastructure and CI policy stay unchanged.

## Next scopes

H2 cancellation, H3 narrow clinical worker/fenced completion, H4 async API/UI, and H5 shared capacity/fault proof remain separately scoped. H1 does not establish real engine availability, clinical validity, model interchangeability, throughput, hosted operation or in-house deployment. See [verification](../../verification/engine-durable-admission.md).
