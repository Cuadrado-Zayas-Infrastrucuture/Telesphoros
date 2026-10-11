# F3 — restricted application recovery

Founder approved this implementation scope on 2026-10-10. Base main `2a6022f` (merged F2 #63), branch `feat/f3-application-recovery`. Work is sequential, with no agents or mandatory graph. This is the report-file recovery F3, distinct from the older API-hosting F3a/F3b.

## Objective and acceptance

Recover the existing synthetic application's evidence reads, authorized PDF/text links and evaluations after primary storage is denied. All required bytes, including soft-deleted references and completed unpinned VCF/JSON, must verify before application startup. The app uses an RLS-bound login and a separate storage credential that reads only the restored application bucket. Clinical use remains unapproved.

| Step | Prerequisite | Deliverable / verification |
| --- | --- | --- |
| Inspect | F2 merged | Confirm actual storage, file-link, evaluation and module call sites; retain existing evidence guards |
| Resolve | Verified DB and all F2 bytes | Authenticated installed catalogue and read-only `RecoveryObjectStorage`; original identities preserved |
| Accept | Resolver verified every required target version | Fresh-process actual application under restricted credentials; HTTP, S3, real reader/engine and ledger checks |
| Gate | Positive and refusal controls pass | Three whitelisted aggregate JSON profiles, exact checkout validation, workspace checks |
| Deliver | Local verification complete | PR only after separate founder authorization; required CI before merge |

## Identity path and custody boundary

Use the translated-copy path for this local slice. The trusted recovery loader checks the format 2 backup, signed F1 completion/catalogue, DB inventory and independent bytes using the F2 protocol. After verified staging, it creates an encrypted/authenticated **installed application catalogue**, reusing the existing catalogue format and cryptography with the original source identities and exact installed destination versions. It is a loader handoff, not an independent-copy completion record or a replacement for the original retained catalogue.

`RecoveryObjectStorage.open` takes that document, its custodied authentication key, the independently verified DB binding/inventory, and a separately configured application-bucket read port. It checks bucket/prefix/binding/membership, versioning, every required object's actual hash/size/type/version and text scalars before returning an adapter. The adapter retains the validated index and read port; it retains neither the authentication key nor administrator/producer credentials. The caller must derive expected facts from a verified restore; copying them from an untrusted document defeats the contract.

`AppModule.register(env, recoveryStorage)` and `ObjectStorageModule.register` explicitly accept the initialized adapter. Default startup remains unchanged. No environment activation, recovery CLI or deployment is added. The trusted loader orchestration and catalogue handoff are exercised in the synthetic test worker; deployment tooling and durable handoff custody remain part of the separately scoped F4 work.

- PDF reads return the original logical version to existing capture checks; S3 requests and signed URLs use the installed destination version.
- Unpinned standard reports/text resolve to their verified observed logical identity. Ambiguous unversioned lookups refuse.
- Unknown keys, wrong pins and missing/corrupt target bytes refuse; never fall back to latest or rewrite DB identity.
- Every link re-verifies exact bytes before signing. Maximum link lifetime is bounded. Already issued bearer links rely on provider version/retention enforcement; F4 must prove it.
- Recovery file storage refuses uploads/text writes. Existing API/DB writes needed for decisions/evaluations remain governed by existing roles and ledger containment.
- Native original-key/version resolution is a unit contract only; no emulator replication claim.

## Acceptance controls and completion boundary

Fresh workers receive no cached report bytes, source endpoint, local backup directory or ambient credentials. A synthetic HTTP boundary denies primary access, copy access to the application credential, and application writes to its target. This proves the fixture's separation, not AWS IAM/signature enforcement.

Positive acceptance uses existing D01/D08 synthetic captures, real authorization guards, actual presigned downloads and the pinned Python reader/adapter/engine. Compare against the existing hand-written golden expectations; check held/non-actionable/unapproved clinical state, tenant isolation, DB pin guards, ledger validity and unchanged evidence inventory. Standard reports have metadata API and application storage reads; the product has no VCF/JSON download endpoint, and this slice does not invent one.

Refuse tampered installed documents, foreign DB/destination bindings, startup missing bytes, post-start PDF/text failure, and independent-copy missing/corrupt/malformed/incomplete discovery. Require fixed error codes; an unrelated internal error cannot satisfy a refusal control. Existing F2 controls cover full mapping, key/policy, pagination, interruption and lost-reply boundaries. Re-run healthy acceptance after faults with zero recovery writes.

`applicationRecoveryComplete=true` means these existing synthetic application paths passed for this recovered dataset. F2 metrics remain false for application recovery. It does not mean a live provider drill, production activation, unrestricted writes, clinical release, native replication, or production RPO/RTO acceptance.

## Verification and exclusions

See [runbook](../../ops/application-recovery.md) and [verification record](../../verification/f3-application-recovery.md). Structured CI artifacts retain aggregate volumes/times and fixed control names only. Workflow instructions are written guidance; test timeouts, schema limits and validators are actual software controls.

Do not change clinical algorithms/prompts/models, schema, immutable DB evidence, backup format, default production activation, infrastructure/IAM, scheduling, real records, AWS resources or spend. F4 requires all founder deployment gates. Reassess after three unsuccessful repairs, repeated identical failures or no measurable progress; classify implementation/environment/requirements/permissions and continue a supported alternative within this scope.

**Fixture blast radius:** tests create their own random synthetic databases, temporary directories and buckets. Restore cleanup drops only newly created disposable databases; target stop removes only its freshly created cluster tree after shutdown succeeds. No existing pilot/production database or shared local cluster is a cleanup target. Task-owned development service data/logs are retained after stopping the services.
