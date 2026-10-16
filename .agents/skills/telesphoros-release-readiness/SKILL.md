---
name: telesphoros-release-readiness
description: Assess Telesphoros release readiness, deployment prerequisites, launch blockers and rollback planning. Use when asked whether a release can ship or what remains before going live. Produce an evidence-based readiness report; invoking this skill does not authorize a deployment, merge or infrastructure apply.
---

# Assess readiness without crossing release gates

Read the [repository context](../../references/telesphoros.md) and the current deployment/hosting plan. Verify current state; a dated "nothing deployed" paragraph is not live-account evidence. Read-only account inspection needs the appropriate connected access; absence of access means unverified.

1. Identify the exact candidate SHA, intended environment, artifact identity and requested outcome. Separate source merged, local verification, required exact-head CI, hosted synthetic acceptance and clinical release. If the user only asks for readiness, remain read-only.
2. Trace each prerequisite to an existing owner and evidence: hosting/state/IAM decisions, migration/provisioning order, identity and tenant containment, rollback/restore procedure, monitoring and delivered alarms, provider/BAA requirements and clinical hold. Synthetic/Moto results do not establish RDS/IAM/KMS behavior or permission to introduce patient data.
3. Verify all six required CI checks for the candidate and inspect material failures/skips. Check real database/profile/recovery and image/security evidence using the existing runbooks. A plan or green local build cannot fill a missing live acceptance row.
4. Produce a bounded rollout/rollback proposal only if requested. Name measurable stop criteria, the last known-good artifact, data compatibility and irreversible effects. Applied migrations may not be safely reversed by an image rollback; record that limitation. Do not run an apply, migration, deploy, DNS change, secret rotation or paid drill while preparing the report.
5. Stop at the actual unmet gate. Do not create a replacement approval system, infer a BAA from encryption, remove a hold, or treat the founder's approval of an engineering plan as release approval. A separately authorized execution task must use the reviewed project runbook and approvals for that exact operation.

**Return:** `gate | candidate/environment | evidence | met/blocked/unverified/not applicable | owner/next decision`. End with a readiness verdict bounded to the requested environment and a list of blockers. The report itself grants no clinical, merge or deployment authorization.

**Self-check:** Is every "met" claim supported by current evidence? Are test/emulator results being presented as hosted proof? Have risky actions stayed proposals rather than tool calls?
