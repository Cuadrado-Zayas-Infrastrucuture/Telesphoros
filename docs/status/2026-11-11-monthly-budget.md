# A monthly cost budget, off until the founder sets the figure

Date: 2026-11-11

Slice A6 of the observability plan (`docs/design/plans/observability-and-backups.md`, decision OB4, approved 2026-11-11). Written and tested,
**not applied**, and it creates nothing yet.

`infrastructure/terraform/budget.tf` adds an AWS Budgets monthly cost budget for the account. It is created only when `monthly_budget_usd` is set;
the variable has no default, because the figure is the founder's. Once set, it emails `alarm_email` (the address the alarms already use) when
actual spend passes 50%, 80% and 100% of the figure, and when the month's forecast passes 100%. It emails directly rather than publishing to the
alarm topic: that topic is encrypted with the audit key, and letting Budgets publish to it would mean granting the Budgets service use of that key.
The staging example tfvars shows the line, commented out.

`infrastructure/terraform/budget.guard.test.mjs` checks those rules, and seven deliberately broken copies (a default figure, always created, no
50% alert, no forecast alert, a different recipient, yearly instead of monthly, an SNS subscriber) each turn it red. `pnpm test:infra` passes.
`terraform fmt`, `validate` and `plan` were not run locally (no Terraform binary in this session); CI's `terraform` job runs the first two.

Not known: whether the staging identity, or the organization's service control policy, allows `budgets:*` in this account. The first plan with a
figure set will say.
