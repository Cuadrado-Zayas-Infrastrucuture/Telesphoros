// Guards for the monthly cost budget (budget.tf). Imported by guard.test.mjs, so `pnpm test:infra` runs it. Like the other guards it reads
// Terraform TEXT, not what AWS does once applied. `budgetProblems` returns what is wrong with a copy of the text (empty when nothing is); the
// tests run it on the real file and on deliberately broken copies, so every rule has been seen to fail.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const budget = readFileSync(new URL('./budget.tf', import.meta.url), 'utf8');
const code = (text) => text.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
const squash = (s) => code(s).replace(/[ \t]+/g, ' ');

export function budgetProblems(text) {
  const t = squash(text);
  const problems = [];
  const need = (ok, why) => ok || problems.push(why);
  need(/variable "monthly_budget_usd" \{[\s\S]*?type = number\n default = null\n/.test(t), 'monthly_budget_usd must default to null: the figure is the founder\'s');
  need(/budget_count = var\.monthly_budget_usd == null \? 0 : 1/.test(t), 'no budget may be created until a figure is set');
  need(/resource "aws_budgets_budget" "monthly" \{\n count = local\.budget_count\n/.test(t), 'the budget must be counted by budget_count');
  need(/budget_type = "COST"/.test(t) && /time_unit = "MONTHLY"/.test(t) && /limit_unit = "USD"/.test(t), 'a monthly cost budget in US dollars');
  need(/budget_actual_percents = \[50, 80, 100\]/.test(t), 'actual-spend alerts at 50, 80 and 100 percent');
  need(/notification_type = "ACTUAL"/.test(t), 'actual spend must alert');
  need(/threshold = 100\n threshold_type = "PERCENTAGE"\n notification_type = "FORECASTED"/.test(t), 'the forecast passing the budget must alert');
  const subscribers = [...t.matchAll(/subscriber_email_addresses = (\[[^\]]*\])/g)].map((m) => m[1]);
  need(subscribers.length === 2 && subscribers.every((s) => s === '[var.alarm_email]'), 'every alert goes to alarm_email, the address the alarms already use');
  need(!/subscriber_sns_topic_arns/.test(t), 'no SNS subscriber: the alarm topic is encrypted with the audit key, which Budgets is not granted');
  return problems;
}

test('the monthly budget is off until the founder sets a figure, then alerts at 50/80/100% actual and 100% forecast', () => {
  assert.deepEqual(budgetProblems(budget), []);
});

test('the budget guard reports each way the text could be weakened (controls)', () => {
  for (const [why, from, to] of [
    ['a default figure', 'default     = null', 'default     = 50'],
    ['always created', 'budget_count = var.monthly_budget_usd == null ? 0 : 1', 'budget_count = 1'],
    ['no 50% alert', 'budget_actual_percents = [50, 80, 100]', 'budget_actual_percents = [80, 100]'],
    ['no forecast alert', 'notification_type          = "FORECASTED"', 'notification_type          = "ACTUAL"'],
    ['alerts to someone else', 'subscriber_email_addresses = [var.alarm_email]\n    }\n  }', 'subscriber_email_addresses = ["someone@example.invalid"]\n    }\n  }'],
    ['yearly instead of monthly', 'time_unit    = "MONTHLY"', 'time_unit    = "ANNUALLY"'],
    ['to the encrypted topic', 'subscriber_email_addresses = [var.alarm_email]\n  }\n}', 'subscriber_email_addresses = [var.alarm_email]\n    subscriber_sns_topic_arns  = [aws_sns_topic.audit_alarms.arn]\n  }\n}'],
  ]) {
    assert.ok(budget.includes(from), `the control for "${why}" must match the real text (it does not: fix the control)`);
    assert.notDeepEqual(budgetProblems(budget.replace(from, to)), [], why);
  }
});
