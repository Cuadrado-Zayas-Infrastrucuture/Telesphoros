# Agent workflow assistant: approval tiers

Status: **draft, awaiting founder decisions.** Snapshot 2026-10-13. This file holds only the approval-tier section of a future agent plan. No agent plan exists yet, and nothing here is built. The rest of the agent plan (scope, data capture, evaluation, training) follows in later sections and needs its own approval.

The Soup pilot ([soup-pilot.md](soup-pilot.md)) is a separate, narrower plan and is unaffected by this file.

## Principle

A human approves every costly or external action. The rule is enforced by the tool layer, not by the model's instructions. The model can propose an action; only the executor can run one, and it refuses unless a valid approval exists for that exact payload.

## Tiers

| Tier | Meaning | Who may approve | Execution |
| --- | --- | --- | --- |
| **T0** | Read, search, summarise, draft. Nothing leaves the system. | None needed | Runs immediately |
| **T1** | Reversible internal write: add an internal note, create an internal task, change an internal status that can be reverted. | Named user with edit rights on the record, or the review window expiring with no cancel (see D-A2) | Runs after approval or after the review window, whichever the policy sets |
| **T2** | Costly or external: messages to customers, billing or contract changes, merging or deleting records, any bulk action over the size limit in D-A3. | Named approver with the role in D-A1, never the requester | Runs only after explicit approval of that payload |
| **T3** | Forbidden to the agent: clinical results or clinical decisions, the audit ledger, cross-tenant access, changes to permissions or the approval rules themselves. | Not applicable: human-only workflow outside the agent | The tool is not offered to the agent at all |

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
3. **Four eyes for T2.** The person who asked for the action cannot approve it (proposed; see D-A4).
4. **Approvals expire.** A T2 approval expires after a short window (D-A5). An expired approval must be requested again.
5. **Fail closed.** If the approver does not respond, the action is cancelled, not executed. A timeout never counts as consent.
6. **Review window for T1.** T1 actions may run after a delay if nobody cancels them. The delay and who can cancel are set in D-A2.
7. **Kill switch.** One control stops every agent write. Reads and proposals continue. Restarting writes needs a named person. The kill switch is tested in CI and in the rehearsal before any write is enabled.
8. **Audit record for every step.** Each proposal, approval, rejection, cancellation, execution and failure is recorded with actor, time, tier, payload hash and outcome. The records are append-only. Where possible they reuse the per-tenant hash-chained ledger pattern already specified in [records-and-corrections.md](../records-and-corrections.md).
9. **Approvals are checked, not assumed.** Weekly, a random sample of approved T1 and T2 actions is audited against the source. Approval times that are implausibly short for the change size are flagged.
10. **Rejections are data, not training.** Rejection reasons are recorded and may later inform training, but only under the data-governance rules of the training plan.

## Moving an action between tiers

- **Down (less approval)** only after a set number of accepted cases with zero costly errors (D-A6), and only with a founder decision recorded in the register.
- **Up (more approval)** immediately after any costly error caused by the agent for that action type. The up-move does not wait for review.
- Every tier change is an audited event.

## Decisions for the founder

- **D-A1 Approver roles.** Which roles approve T2 for each action type? Who may approve for customers and for billing?
- **D-A2 Review window.** How long, and who may cancel a T1 action during it?
- **D-A3 Bulk limit.** Above how many records or customers does a change become T2?
- **D-A4 Four eyes.** Confirm that the requester can never approve their own T2 action, or describe the exception.
- **D-A5 Approval expiry.** How long is a T2 approval valid?
- **D-A6 Promotion threshold.** How many accepted cases, and what error rate, before an action type can move to a lower tier?
- **D-A7 Register owner.** Who maintains the action register, and who may change a tier?

Until D-A1 to D-A7 are answered, no action type may be built beyond T0.

## Not covered here

- The model, its training data and its evaluation (later sections).
- Whether any workflow falls under clinical or device regulation. That needs a separate check.
- Vendor data terms for any hosted model. Not verified here.
