# F4 provider/custody preparation verification

Scope: [approved documentation-only preparation](../design/plans/f4-provider-custody.md), base main `60a73aa` (merged F3 #64), branch `chore/f4-provider-custody-plan`. No application, schema, infrastructure, credential, provider-account or live-resource change.

## Repository reconciliation

- Fetched main and checked all-state recent PRs: #62/#63/#64 merged; no duplicate F4 preparation PR was listed.
- Inspected real producer/storage/recovery module/main entry points, CLI flags, package commands, Terraform profile/guards and existing runbooks. Translated production library contracts exist; native replica catalogue publication and operational producer/loader/bootstrap do not. Test helper orchestration is not a deployable command.
- The synthetic Terraform profile refuses Compliance mode; the production root uses two Regions. The plan preserves both existing safeguards and requires a separately reviewed eligible retained destination. The different-provider DB-backup requirement stays open.
- Reconciled F3 final merged/tree/log/artifact evidence in its verification record, status and parent design. The tested PR merge checkout differs from the reviewed head SHA but has the same tree; downloaded artifacts were validated against the actual tested checkout, not mislabeled as main-head evidence.

## Local checks

| Check | Result |
| --- | --- |
| Document/source links and anchors | 115 resolve across all five changed documents; no zero-width formatting artifact |
| Bash examples and package/spec references | Three fenced shell blocks parse; referenced scripts and four specs exist |
| `pnpm test:ci-config` | 34 passed, zero failures/skips |
| `pnpm test:infra` | 31 passed, zero failures/skips; existing profile refusal remains enforced |
| Focused recovery resolver | Six passed under Node 22.22.0/pnpm 10.28.0 using the existing private native-dependency cache |
| `git diff --check` | Passed |

The first resolver invocation failed before running tests with `Failed to load native binding`. This was an **environment** failure; selecting the existing `SWC_NATIVE_BINDING_CACHE` resolved it without editing dependencies or weakening tests. Jest also prints the expected unselected DB/S3 service notice; six resolver controls passed, but no service integration is claimed. No live AWS API, account inspection, Terraform plan/apply or restore was run. Workspace-wide build/lint/typecheck were not rerun for documentation-only edits.

## Sources and unavailable evidence

AWS primary documentation for Object Lock, version/retention replication, encrypted replication, Batch Replication and CLI input options was inspected on 2026-10-10 local time; links are next to claims in the plan. AWS CLI 2.34.19 is installed on macOS/arm64; offline `--generate-cli-skeleton input` accepts the documented lock/retention/replication commands. No credentials or profiles were read. Terraform is unavailable on this shell PATH; no terminal Terraform validation is claimed.

F4 operational commands and live acceptance are **unimplemented/unverified**. Existing baseline service integration was not rerun for this documentation change; previous F3 evidence is scoped to its recorded tested checkout. All founder decisions remain unresolved, including platform/Region/provider eligibility, BAA/first-apply conditions, formal retention, RPO/RTO, volume/budget, independent custodians and evidence sink. No permission/retention/native replication or clinical acceptance follows from this preparation.

## Delivery

Local preparation and PR delivery are distinct. A new documentation PR requires founder authorization; required CI/log inspection follows that authorization. Future P1/P2 implementation and P3 live drill each require a concrete separately approved scope. No live step is ready.
