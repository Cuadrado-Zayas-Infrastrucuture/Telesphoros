# Agent workflow assistant: approval tiers

Status: **draft, awaiting founder decisions.** Snapshot 2026-10-13, revised after mapping the repository. This file holds only the approval-tier section of a future agent plan. No agent plan exists yet, and nothing here is built. The rest of the agent plan (scope, data capture, evaluation, training) follows in later sections and needs its own approval.

The Soup pilot ([soup-pilot.md](soup-pilot.md)) is a separate, narrower plan and is unaffected by this file.

## Principle

A human approves every costly or external action. The rule is enforced by the tool layer and the database, not by the model's instructions. The model can propose an action; only the executor can run one, and it refuses unless a valid approval exists for that exact payload.

## Tiers

| Tier | Meaning | Who may approve | Execution |
| --- | --- | --- | --- |
| **T0** | Read, search, summarise, draft. Nothing leaves the system. | None needed | Runs immediately |
| **T1** | Reversible internal write: add an internal note, create an internal task, change an internal status that can be reverted. | A named user with edit rights on the record, or the review window expiring with no cancel (D-A2) | Runs after approval or after the review window |
| **T2** | Costly or external: messages to customers, billing or contract changes, merging or deleting records, any bulk action over the limit in D-A3. | A named approver with the role in D-A1, never the requester | Runs only after explicit approval of that payload |
| **T3** | Forbidden to the agent: clinical results or clinical decisions, the audit ledger, cross-tenant access, changes to permissions or the approval rules themselves. | Not applicable: human-only outside the agent | The tool is not offered to the agent at all |

**Approver roles (D-A1, recommended).** Where the agent acts on clinical records in this repository, reuse the existing `reviewer` role from [auth.md](../../auth.md): it is additive, and no other role implies it. Customer messages and billing changes have no role in this repository, so they need new Cognito groups, defined under D-A1 before any such action type is built.

Action types are assigned to tiers one by one in an action register. The register below is an illustrative starting point for the founder to correct, not a decision:

| Action (illustrative) | Tier | Blast radius | Reversible |
| --- | --- | --- | --- |
| Search or summarise a record | T0 | One record, read only | n/a |
| Draft a reply, never sent | T0 | None | Yes |
| Add internal note | T1 | One record | Yes |
| Create internal task | T1 | One record | Yes |
| Change internal status | T1 | One record | Yes, if the prior status is recorded |
| Send message to a customer | T2 | One customer | No |
| Change billing, pricing or contract terms | T2 | One customer, money | Partly |
| Merge or delete records | T2 | Record and history | Partly |
| Bulk change above the D-A3 limit | T2 | Many customers | Depends |
| Anything touching clinical results | T3 | Patient safety | n/a |
| Change audit log or approval rules | T3 | Governance | n/a |

## What an approver sees

Each T1 or T2 proposal shows:

- the **exact change**: record before and after, and the full payload the executor will run, not a summary
- the **source**: which text the agent relied on, shown as untrusted quoted data
- the **blast radius** label from the register
- the **reversal** note: what undoing the action involves
- a reason field, required on rejection, using a fixed list of reason codes plus free text

The approval is bound to a hash of the payload. If the payload changes after approval, the approval is void.

## Rules

1. **The tool layer decides, not the model.** Each tool declares its tier. The executor checks a valid approval for that payload hash before running any T1 or T2 action. Prompt text cannot raise or lower a tier.
2. **Untrusted content cannot change the approval path.** Text from emails, tickets, transcripts and contracts can inform a proposal, but it cannot name an approver, change a tier, or add an action. A test injects such text and checks that the tier and approver are unchanged.
3. **Four eyes for T2, enforced in the database.** The person who asked for the action cannot approve it (D-A4). Where the data lives in the database, the rule is a database constraint, following the pattern the repository already uses for lab-report captures: four identities cannot accept a capture, enforced by migration 0010 and tested for each identity ([records-and-corrections.md](../records-and-corrections.md) §16). A test must show each identity refused.
4. **Approvals expire.** A T2 approval expires after 30 minutes (D-A5). An expired approval must be requested again.
5. **Fail closed.** If the approver does not respond, the action is cancelled, not executed. A timeout never counts as consent.
6. **Review window for T1.** T1 actions run after 15 minutes if nobody cancels them, and the requester or the approver may cancel (D-A2).
7. **Kill switch is a global hold.** One control stops every agent write, following the global-hold design in [fd2-ledger-containment.md](fd2-ledger-containment.md): it stops everyone, it is a human act, and only a named person may lift it. Reads and proposals continue. The kill switch is tested before any write is enabled.
8. **Audit record for every step.** Each proposal, approval, rejection, cancellation, execution and failure is recorded with actor, time, tier, payload hash and outcome. The records are append-only, and they reuse the per-tenant hash-chained ledger pattern already specified in [records-and-corrections.md](../records-and-corrections.md).
9. **Approvals are checked, not assumed.** Weekly, a random sample of approved T1 and T2 actions is audited against the source. Approval times that are implausibly short for the change size are flagged.
10. **Rejections are data, not training.** Rejection reasons are recorded and may later inform training, but only under the data-governance rules of the training plan.

## Moving an action between tiers

- **Down (less approval)** only after 50 accepted cases with zero costly errors for that action type (D-A6), with a recorded decision by the register owner and a second approver (D-A7).
- **Down is blocked until a second approver is named.** The repository currently has one named reviewer and no two-person approval (the second-reviewer decision, FD-8, is open). Until D-A7 names a second person, no action type may move below its starting tier.
- **Up (more approval)** happens immediately after any costly error caused by the agent for that action type. The up-move does not wait for review.
- Every tier change is an audited event.

## Decisions for the founder

Each row gives the recommended value, the reason, and its status. All values are recommendations until the founder records them.

| # | Decision | Recommendation | Grounding |
| --- | --- | --- | --- |
| **D-A1** | Approver roles, by action type | Clinical records: the existing `reviewer` role, never the requester. Customer messages and billing: new groups, defined before those types exist. | [auth.md](../../auth.md) roles table |
| **D-A2** | Review window for T1 and who may cancel | 15 minutes; cancellable by the requester or the approver | No precedent in the repository; starting number |
| **D-A3** | Bulk limit | More than 10 records, or more than one customer, makes a change T2 | No precedent; conservative starting number |
| **D-A4** | Four eyes | Accept: the requester can never approve their own T2 action, enforced in the database | Four-identity rule, migration 0010 |
| **D-A5** | Approval expiry | 30 minutes | No precedent; starting number |
| **D-A6** | Promotion threshold | 50 accepted cases with zero costly errors before moving down; any agent-caused costly error moves up immediately | Clearance design treats downgrades as human acts ([fd2-ledger-containment.md](fd2-ledger-containment.md)) |
| **D-A7** | Register owner and second approver | The founder owns the register. Moving any action type down needs a second approver, so tier-downs stay blocked until one is named. | One reviewer on record; FD-8 open ([ledger-watch.md](../../ops/ledger-watch.md)) |

Until D-A1 to D-A7 are answered, no action type may be built beyond T0. Tier-downs additionally wait for a second approver under D-A7.

## Ideas borrowed from autoresearch

From [karpathy/autoresearch](https://github.com/karpathy/autoresearch), where a human edits the agent's instructions (`program.md`) and the agent works only inside the code it is allowed to change:

- **The register is human-edited.** The action register and its tiers are a file that people change under D-A7. The agent may propose a change, shown as a diff, but it cannot apply one.
- **Read-only checks.** The approval rules and the executor's tests are outside the agent's write scope, the same way `prepare.py` is read-only for the autoresearch agent.
- **A logged outcome for every attempt.** Each agent action is logged with a status (`executed`, `rejected`, `cancelled`, `failed`), as autoresearch logs `keep`, `discard` and `crash`. Logs are append-only.

Not borrowed: unattended operation and the instruction to disable permissions. Our tiers exist to prevent exactly that.

## Repository grounding

- Roles and their additive rule: [auth.md](../../auth.md).
- Four-identity precedent and the "at least two people able to review" statement: [records-and-corrections.md](../records-and-corrections.md) §16, and [STATUS.md](../../STATUS.md) decisions on record.
- Global-hold and single-operator clearance: [fd2-ledger-containment.md](fd2-ledger-containment.md) and [ledger-watch.md](../../ops/ledger-watch.md).
- The second-reviewer decision (FD-8) is not built and is not decided.

## Not covered here

- The model, its training data and its evaluation (later sections).
- Whether any workflow falls under clinical or device regulation. That needs a separate check.
- Vendor data terms for any hosted model. Not verified here.
