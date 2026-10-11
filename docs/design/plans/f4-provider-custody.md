# F4 report-file recovery: provider and custody drill preparation

Founder approved **documentation-only preparation** with “go” on 2026-10-10. Base main is `60a73aa` (merged F3 #64). This document authorizes no account access, infrastructure change, deployment, credential change, spend, scheduler or real records. “F4” here means report-file recovery, not the separate API deployment-pipeline work with the same label.

## Completion boundary and current evidence

Preparation is complete when the gaps, founder decisions, ordered implementation steps, drill controls and evidence destination are reviewable against the repository. Live F4 remains **pending**. This is workflow guidance, not a scheduler or an implemented retry policy.

| Built on main | Verified boundary | Missing for live F4 |
| --- | --- | --- |
| F1 catalogue, #62 | Authenticated DB-bound membership; bounded discovery; exact copied versions and completion last | Operational producer command, provider policy and custody verification; native-replica catalogue publication |
| F2 independent recovery, #63 | Fresh synthetic worker; primary denied; DB and every required copied byte verified | Operational loader, live credentials/permissions and provider evidence |
| F3 application recovery, #64 | Opt-in read-only adapter; actual synthetic API/file/evaluation paths under restricted DB/storage roles | Durable authenticated installed-catalogue handoff and recovery startup entry point |
| Existing Terraform | Reports are private, versioned, KMS-encrypted in written configuration | Report Object Lock/replication resources, independently administered destination and recovery reader/loader policies |
| Existing DB CLI | Encrypted format 2 backup, remote upload/check and verified restore | Report-file orchestration; a successful DB restore alone does not complete F4 |

F3 merged at `60a73aa`; its tree matches reviewed head `7038d53` and tested checkout `718b456`. All seven CI jobs passed; inspected database tiers passed **1,630 / 1,811 / 1,812** tests with **182 / 1 / 0** expected profile skips and no failures or emitted missing-service notices. Downloaded F2/F3 artifacts passed strict validators in all three profiles at that tested checkout. See [merged F3 evidence](../../verification/f3-application-recovery.md#merged-delivery-evidence) and [PR #64](https://github.com/Cuadrado-Zayas-Infrastrucuture/Telesphoros-Remastered/pull/64).

### Constraints that cannot be bypassed by this plan

- The [synthetic Terraform profile](../../../infrastructure/terraform/profile.tf) explicitly refuses Compliance locks. Keep that refusal and its destroyable rehearsal intact. A separately reviewed destination configuration must support retained synthetic canaries without promising immediate teardown.
- The current production root selects two Regions. The reviewed [recovery design](report-file-recovery.md#copy-and-retention-options) keeps cross-Region actions conditional on founder approval and verified platform eligibility. Neither existing profile is a ready-made F4 deployment.
- [main.ts](../../../apps/backend/src/main.ts) registers the ordinary application module; it does not load recovery storage. [RecoveryObjectStorage.open](../../../apps/backend/src/object-storage/recovery-object-storage.ts) is a library, not a recovery command. Test helpers are not production entry points.
- [produceEvidenceCatalogue](../../../apps/backend/src/db/evidence-producer.ts) currently produces translated copies. Native mapping validation does not implement native replica discovery/publication. Native selection needs its own integration before the drill.
- The [different-provider DB backup requirement](../../ops/offsite-backups.md) remains open. Same-Region S3 report replication does not satisfy that separate requirement. Do not relax it implicitly.

## P0 — founder decision record

Every item below is **unresolved**; an approval of preparation is not a deployment approval. Record the decision, approver, date and restricted evidence reference before live work. The [existing founder checklist](report-file-recovery.md#founder-deployment-gates--required-before-f4) remains the authority; this table makes its operational inputs concrete.

| Gate | Founder decision and required evidence |
| --- | --- |
| Infrastructure | Exact source/destination Regions, provider/account scope, independently controlled custodian, permitted platform path and eligibility evidence; choose native SRR, conditional CRR or translated copies |
| Compliance | BAA coverage for every service/provider before real records; this drill stays synthetic. Record synthetic eligibility and all repository first-apply prerequisites, including the root's BAA gate, without treating synthetic data as permission to bypass them |
| Policy | Fixed retention term for evidence/catalogue/completion, deletion and legal-hold procedures, separate canary volume/expiry, and how installed application copies remain protected throughout issued-link validity |
| Recovery objectives | Target RPO/RTO, outage scenarios, maximum copy lag/backup age, drill dataset and accepted Region-loss limit for SRR |
| Financial | Approved storage classes, all-version volume/growth, backfill/verification/request/KMS/audit costs, drill retrieval/egress costs, retained canary costs, spending ceiling and stop threshold |
| Custody | Named independent destination/key custodians, offline backup/catalogue-key recovery procedure, access-controlled evidence sink, retention and reviewers |

No dollar estimate or numerical production objective is selected here. Obtain dated provider/Region/class estimates using approved volume. A retained version can outlive the drill; budget its entire term. [S3 pricing](https://aws.amazon.com/s3/pricing/).

## Architecture choice to review

**Preferred candidate:** native version-preserving SRR into an independently administered AWS account in the permitted Region, if platform eligibility and custody permit it. S3 replication retains original metadata/VersionIds; the catalogue still binds complete membership to the verified DB recovery point. Separate bucket names alone do not establish **custody isolation**. Record who can assume destination roles, change policy, administer keys or control the account. [Replication](https://docs.aws.amazon.com/AmazonS3/latest/userguide/replication.html).

**CRR evaluation:** explicitly assess another Region's failure isolation, eligibility, key custody, transfer costs and recovery latency. Keep it conditional; do not execute it under the current single-Region constraint. SRR must record whole-Region loss as an accepted limitation, not a passing control.

**Translated-copy alternative:** select an independent S3-compatible provider only after its BAA, retention, credential, encryption and recovery semantics are verified. Reuse the signed source-to-destination mapping and original DB pins. Do not assume AWS Object Lock behavior for a compatible API. Record why this path satisfies the separate provider/custody requirements.

**Retention:** evaluate fixed S3 Object Lock **Compliance Mode** on every required retained report/text version, encrypted catalogue and completion record. It prevents version deletion or shortening retention even by root during the term; it permits newer versions/delete markers and cannot be disabled after bucket enablement. Use version-specific checks, never just bucket defaults. [Object Lock](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html).

**Encryption and native copies:** require explicit selection of KMS-encrypted objects, a valid destination key, scoped source-decrypt/destination-encrypt permissions, versioning and destination ownership. A configured replication rule is not proof of delivery. Inspect actual replica retention: source retention overrides destination defaults when present. [KMS replication](https://docs.aws.amazon.com/AmazonS3/latest/userguide/replication-config-for-kms-objects.html), [replication requirements](https://docs.aws.amazon.com/AmazonS3/latest/userguide/replication-requirements.html), [retention inheritance](https://docs.aws.amazon.com/AmazonS3/latest/userguide/replication-what-is-isnot-replicated.html).

Object Lock does not preserve decryption access. Primary administrators must not be able to disable/delete destination keys or retrieve catalogue/backup authentication keys. Test offline key recovery under the destination custodian; do not schedule key deletion or rotate real keys to simulate loss. [Lock and encryption](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock-managing.html).

## Ordered work — no live step is ready

Keep work sequential and one PR per intention, each off main. Begin only after prerequisites and its scope approval are satisfied. No task graph or delegation is requested.

| Priority / task | Prerequisites | Owner / deliverable | Status |
| --- | --- | --- | --- |
| P0 decisions | This preparation reviewed | Founder/custodians; completed gate record and selected identity path | pending |
| P1 producer integration | Identity path selected; separate code scope approved | Engineer; operational catalogue command; native verifier/publisher if native selected; existing crypto/completion/discovery limits retained | pending |
| P1 loader and startup | Producer contract settled; separate code scope approved | Engineer; verified restore/installed catalogue handoff and explicit recovery bootstrap without admin/copy secrets in the app | pending |
| P2 infrastructure review | P0; code contracts; separate infrastructure scope approved | Engineer/custodian; scoped policies, retained destination, key/audit/monitoring configuration and reviewed plan with remote state; no weakening of existing profiles | pending |
| P3 synthetic live drill | All founder gates; P1/P2 verified; written blast-radius and explicit live approval | Operator/custodians; apply only approved resources, exercise controls below and retain evidence | pending |
| P4 acceptance and closure | Every required control passed; evidence/cost review | Founder; scoped result, retained-resource owner/expiry and unresolved limitations | pending |

### P1 acceptance contracts

- **Producer:** verify the format 2 restore and derive complete membership, including soft-deleted rows and completed unpinned VCF/JSON; resolve hash-bound text exactly. Native mode reads actual original key/version replicas, verifies bytes/encryption/retention, and publishes an authenticated native catalogue only after every member is complete. Translated mode retains signed exact mappings. Backfill historical required versions using a version-specific manifest, retain Batch completion results, and independently read all required replicas. A “job complete” result alone is insufficient. [Batch Replication](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-batch-replication-batch.html).
- **Loader:** independently derive binding/inventory from the verified restored DB; verify retained catalogue/completion and all bytes before startup. Retrieve keys through approved offline custody, stage exact application copies if selected, authenticate/encrypt the installed catalogue and bind expected target independently. Separate DB loader, copy reader, target writer, app reader and ledger verifier. App readers cannot write, access primary/custody storage or administer policy/keys.
- **Startup:** explicitly initialize `RecoveryObjectStorage.open` and inject it through `AppModule.register`; refuse corrupt/missing/foreign handoffs before listening. Preserve original immutable DB evidence identity, tenant predicates, existing auth, ledger and clinical holds. The native/translated choice must not silently fall back to ordinary primary storage.
- **Link protection:** verify how every installed version survives at least the issued link's expiry (adapter permits at most 900 seconds), including destination administrator threat and retention refresh. Existing byte verification/expiry checks do not by themselves prove this live policy.
- **Durability:** specify safe resume and owned temporary cleanup for normal exit/interruption; test a fresh host without HOME/XDG/ambient credentials or cached primary bytes. Abrupt termination handling needs explicit implementation/evidence before being claimed.

### Bounds and feedback

Existing [EvidenceBudget](../../../apps/backend/src/db/evidence-storage.ts) caps a budget at 1,000 listing pages, 10,000 examined versions/references, 1 GiB combined consumed-read/submitted-write payloads, 30 seconds per request and 15 minutes overall. `S3EvidenceStorage` makes at most three transient read attempts and does not blindly retry writes. A terminal page 1,000 is valid; a truncated cap, missing/repeated cursor or timeout refuses. These are enforced library limits; they are not production capacity or a scheduler. F4 must record per-phase budgets and complete end-to-end bounds before implementation; do not reset budgets silently to conceal exhaustion. Larger datasets require a separately approved streaming/partition/capacity design, not disabling guards.

Inspect → focused change → relevant checks → observed diagnosis → repair. After three unsuccessful repairs, identical failures without new evidence or no measurable progress, reassess and classify implementation/environment/requirements/permissions. Network, auth and service failures are **inconclusive/fail**, not proof of deny/retention enforcement. Continue a supported alternative inside approved scope; stop only where a decision or authorization blocks it.

## P3 acceptance checklist

Every control records pass/fail/inconclusive and sanitized evidence references. An incomplete or refused recovery never reports application completeness. Faults affect only owned synthetic canaries/targets.

- [ ] **F4-C01 — identity/custody:** independently attest active principal/account/Region/provider and role boundaries. Primary/app principals cannot read/write/delete custody storage, assume its admin/reader or disable/delete its keys. Recovery reader can read exact retained versions but cannot write/delete; app reader accesses only designated application copies.
- [ ] **F4-C02 — retention enforcement:** inspect actual mode/expiry on all required versions and catalogue/completion. Use the same authorized test principal to delete an unlocked disposable control successfully and to attempt version deletion/retention shortening on a separately retained Compliance canary; expect provider refusal, then re-read unchanged bytes/retention. Never use root or required recovery evidence for destructive probes. A permission-only denial does not prove Compliance enforcement; a simple DELETE may merely add a marker.
- [ ] **F4-C03 — historical completeness:** include PDFs, captured Unicode text, completed unpinned VCF/JSON, soft-deleted evidence and pre-rule historical versions. Verify original/native or signed translated identities and every required hash; count incomplete registrations/orphans separately. Missing member/short retention/missing mapping keeps completion unpublished.
- [ ] **F4-C04 — lag/freshness:** retain independent producer generations, protected DB timestamp, publication time, backfill results and copy failure/lag alerts. Compare against approved age/lag limits; stale authenticity does not pass. Missing/repeated cursors, truncated hard caps or timeouts refuse, including DB `IncompleteBackupListingError` and evidence `IncompleteEvidenceListingError`.
- [ ] **F4-C05 — independent restore:** deny primary before the positive drill; restore the specific verified backup and complete evidence on a fresh host with recovery credentials and offline keys only. Record zero successful primary reads, exact object pins, schema/catalog/RLS/ACL/ledger checks, and clean temporary ownership. Never restore over an existing data-bearing database.
- [ ] **F4-C06 — application acceptance:** actual authenticated API/file-link downloads match verified PDF/text bytes; existing standard-report metadata/provider reads pass. Unauthorized/foreign tenants and soft-deleted rows remain hidden. Existing pinned reader/engine controls and clinical holds pass; DB evidence pins remain unchanged. No standard-report download endpoint is invented. Read-only writes refuse.
- [ ] **F4-C07 — refusal/resume:** use distinct disposable generations for bad/missing bytes, tampered/foreign/duplicate mappings, lost reply, missing/wrong keys, interrupted recovery and a newer substitute/delete marker. Wrong/missing keys are injected only into isolated recovery configuration. Re-run healthy recovery after faults and prove safe stage reuse rather than blind writes. Faults are not allowed to damage retained required versions.
- [ ] **F4-C08 — audit/cost/closure:** cover source, custody and installed paths with private encrypted audit evidence, data-event coverage and failure/freshness alerts; exclude content from logs. Review measured recovery scope, incurred/remaining retained costs, evidence access, retained-resource ownership and cleanup plan. Operational readiness and clinical release remain separate sign-offs.

### Written blast-radius check before any live mutation

Identify exact accounts/Regions, owned synthetic resource IDs/versions, principal, action and upper byte/object/cost limits; verify they match the approved manifest. State what may be lost, how the disposable unlocked control is recreated, which locked versions must survive, how policies/access are restored, and who owns costs until expiry. Stop on scope mismatch. No blanket destroy, source outage, real-key deletion/rotation, account closure, or shortening locks. Primary denial is scoped to the isolated recovery process/canary path, never an application-wide outage. Cleanup is separately reviewed after retained expiry; Compliance-protected objects remain until their term ends.

## Commands available now

These are **existing local baseline checks**, not a live F4 implementation. Run from repository root with Node **22.22.0** and pnpm **10.28.0**. On macOS use the installed PostgreSQL 16 tools when provisioning owned loopback fixtures; do not assume Linux service commands. Install the platform SWC native dependency or select the existing private `SWC_NATIVE_BINDING_CACHE` used for local verification; a missing native binding is an environment failure. Missing `TEST_DATABASE_URL`/`TEST_S3_ENDPOINT` means integration skips, not acceptance.

```bash
pnpm --filter @telesphoros/backend test --runInBand --runTestsByPath test/recovery-object-storage.spec.ts
pnpm --filter @telesphoros/backend test --runInBand --runTestsByPath test/db/evidence-catalogue.pg-spec.ts test/db/independent-recovery.pg-spec.ts test/db/application-recovery.pg-spec.ts
pnpm build
pnpm lint
pnpm typecheck
pnpm test:infra
pnpm test:ci-config
```

For full profile regeneration use the existing [F3 commands](../../ops/application-recovery.md#available-verification-commands), then `node .github/ci/verify-recovery-metrics.mjs` and `node .github/ci/verify-application-recovery.mjs`. Validators require **all three profiles at the actual checkout SHA**; an old artifact is not evidence for a new doc commit. Required CI and actual logs are inspected when a PR is authorized; this documentation change does not rerun live recovery or claim current-head service evidence.

### AWS inspection examples — future approved live scope only

These read-only examples assume the **AWS path was selected**. `TASK_F4_PROFILE` is the approved destination inspection identity; `TASK_F4_REGION`, `TASK_F4_BUCKET`, `TASK_F4_OWNER`, `TASK_F4_KEY` and `TASK_F4_VERSION` are independently supplied, allowlisted values from the restricted drill manifest. `TASK_F4_EVIDENCE_DIR` is an existing private directory. Values are not selected here. Do not copy source profile/bucket into destination commands. Preserve raw account/object metadata in the restricted evidence sink, never public CI/chat. No credentials in arguments, debug output or signed URLs.

```bash
aws --profile "${TASK_F4_PROFILE:?}" --region "${TASK_F4_REGION:?}" --no-cli-pager sts get-caller-identity > "${TASK_F4_EVIDENCE_DIR:?}/identity.json"
aws --profile "${TASK_F4_PROFILE:?}" --region "${TASK_F4_REGION:?}" --no-cli-pager s3api get-object-lock-configuration --bucket "${TASK_F4_BUCKET:?}" --expected-bucket-owner "${TASK_F4_OWNER:?}" > "${TASK_F4_EVIDENCE_DIR:?}/bucket-lock.json"
aws --profile "${TASK_F4_PROFILE:?}" --region "${TASK_F4_REGION:?}" --no-cli-pager s3api get-object-retention --bucket "${TASK_F4_BUCKET:?}" --expected-bucket-owner "${TASK_F4_OWNER:?}" --key "${TASK_F4_KEY:?}" --version-id "${TASK_F4_VERSION:?}" > "${TASK_F4_EVIDENCE_DIR:?}/version-retention.json"
```

For native source-rule inspection, use a **separately approved source inspector profile/account/bucket/Region** with `aws s3api get-bucket-replication`; retain its output privately. This proves rule configuration only. The installed AWS CLI accepts the retention/lock/replication input shapes offline; live authorization, ownership, encryption, retention and replication remain unverified. [Retention CLI](https://docs.aws.amazon.com/cli/latest/reference/s3api/get-object-retention.html), [lock CLI](https://docs.aws.amazon.com/cli/latest/reference/s3api/get-object-lock-configuration.html), [replication CLI](https://docs.aws.amazon.com/cli/latest/reference/s3api/get-bucket-replication.html).

No `report-recovery`/native-publisher/live-drill command exists today. Future implementation must document tested invocation and fail-closed output before P3. Do not run the DB `backup-check` expecting report-file acceptance: its governance/canary defaults and DB-only membership do not prove this Compliance drill.

## Measurement and evidence sink

**Restricted durable evidence:** custodian-selected, encrypted, independently controlled destination; approve retention/access before the drill. Preserve a dated drill manifest, gate approvals, tested commit/image, exact backup/catalogue/completion/installed-document bindings, policy/key/retention observations, actual request outcomes and private audit/backfill evidence. Protect these identifiers; publish only sanitized references/digests. Hashes provide integrity links, not authenticity by themselves; use the existing authenticated documents and an approved custodian attestation. A GitHub badge or stdout tail is not custody evidence.

**Aggregate result:** proposed `f4-provider-custody-metrics.json` is a future artifact schema, not an implemented validator. Record synthetic flag, tested commit/runtime, selected identity mode, named control results, independent primary-read count, timestamps/producer lag, and separate database/byte/application/native/custody acceptance. Keep `clinicalUseApproved=false`. A translated path keeps native replication false; a native pass requires live native evidence. Never carry a completeness flag from one failed attempt to another.

Record exact source/restored physical DB bytes, encrypted archive/catalogue bytes, unique required PDF/text/VCF/JSON counts/bytes, copied/verified/read/submitted-write payloads with decimal GB and binary GiB. Label payload counters separately from provider/network transfer or billed retrieval. Pair monotonic inventory/copy/backfill/download/restore/verification/application/end-to-end times with dataset volume, concurrency, storage classes, cold-retrieval wait and key/custody assumptions. Start the operational elapsed timer at the approved outage declaration and include credential/key acquisition, recall, startup and acceptance; state cleanup timing separately. Report the protected DB point and complete generation used for observed data-loss window. Compare measured RTO/RPO with founder targets only for this volume/scenario; tiny synthetic timings cannot establish production guarantees.

CI's existing seven-day F1/F2/F3 aggregates remain useful baseline evidence; they are not the durable live F4 sink. A future F4 schema/validator must reject identifiers, report bytes, paths, signed URLs, resolved secrets and incomplete required controls. CI retention is not extended by this document.

## Verification of this preparation

Repository call sites and current constraints were inspected; F3 merged/tree/CI evidence was reconciled. AWS sources were checked on 2026-10-10 local time. Local command/schema/link checks are recorded in [preparation verification](../../verification/f4-provider-custody-plan.md). No AWS profile, account, BAA, provider policy, cost quote, live resource or decryption key was inspected. Founder gates, P1/P2 implementation and the live drill remain pending.
