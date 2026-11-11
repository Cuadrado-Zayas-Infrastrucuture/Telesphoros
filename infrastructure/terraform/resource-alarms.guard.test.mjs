// Guards for the resource alarms (resource-alarms.tf). Imported by guard.test.mjs, so `pnpm test:infra` runs it. Like the other guards it reads
// Terraform TEXT, not what AWS does once applied. `resourceAlarmProblems` returns what is wrong with a copy of the text (empty when nothing is);
// the tests run it on the real file and on deliberately broken copies, so every rule has been seen to fail.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const tf = readFileSync(new URL('./resource-alarms.tf', import.meta.url), 'utf8');
const code = (text) => text.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
const squash = (s) => code(s).replace(/[ \t]+/g, ' ');

function block(t, name) {
  const start = t.indexOf(`resource "aws_cloudwatch_metric_alarm" "${name}" {`);
  if (start < 0) return '';
  let depth = 0;
  let i = t.indexOf('{', start);
  for (; i < t.length; i++) {
    if (t[i] === '{') depth++;
    else if (t[i] === '}' && --depth === 0) break;
  }
  return t.slice(start, i + 1);
}

const ALARMS = {
  database_cpu_credits_low: ['AWS/RDS', 'CPUCreditBalance', 'LessThanThreshold', '20'],
  database_memory_low: ['AWS/RDS', 'FreeableMemory', 'LessThanThreshold', '134217728'],
  database_read_latency_high: ['AWS/RDS', 'ReadLatency', 'GreaterThanThreshold', '0.1'],
  service_resources: ['AWS/ECS', 'each.value.metric', 'GreaterThanThreshold', '90'],
  password_notifier_errors: ['AWS/Lambda', 'Errors', 'GreaterThanOrEqualToThreshold', '1'],
};

export function resourceAlarmProblems(text) {
  const t = squash(text);
  const problems = [];
  const need = (ok, why) => ok || problems.push(why);
  for (const [name, [namespace, metric, comparison, threshold]] of Object.entries(ALARMS)) {
    const b = block(t, name);
    if (!b) {
      problems.push(`${name} is missing`);
      continue;
    }
    const metricLine = metric.startsWith('each.') ? `metric_name = ${metric}` : `metric_name = "${metric}"`;
    need(b.includes(`namespace = "${namespace}"`) && b.includes(metricLine), `${name} must watch ${namespace} ${metric}`);
    need(b.includes(`comparison_operator = "${comparison}"`) && new RegExp(`\\n threshold = ${threshold.replace('.', '\\.')}\\n`).test(b), `${name} must fire ${comparison} ${threshold}`);
    need(b.includes('alarm_actions = [aws_sns_topic.audit_alarms.arn]') && b.includes('ok_actions = [aws_sns_topic.audit_alarms.arn]'), `${name} must notify the audit topic when it fires and when it clears`);
    need(b.includes('treat_missing_data = "notBreaching"'), `${name}: a metric that is not reported yet is not a fault`);
  }
  need(/database_cpu_credits_low" \{\n count = startswith\(local\.db_instance_class, "db\.t"\) \? 1 : 0/.test(t), 'the credit alarm exists only for a burstable class');
  for (const key of ['api-cpu-high', 'api-memory-high', 'worker-cpu-high', 'worker-memory-high']) need(t.includes(`${key} = {`), `the ${key} alarm is missing`);
  need(/service_resource_alarms = local\.api_service_count == 0 \? \{\} :/.test(t), 'the service alarms exist only where the services do');
  need(!/AWS\/CloudFront/.test(t), 'no CloudFront alarm: its metrics are only in us-east-1, and the project stays in one Region');
  return problems;
}

test('the resource alarms watch credits, memory, latency, service CPU and memory, and notifier failures, and say when they clear', () => {
  assert.deepEqual(resourceAlarmProblems(tf), []);
});

test('the resource alarm guard reports each way the text could be weakened (controls)', () => {
  for (const [why, from, to] of [
    ['credit threshold lowered to never fire', 'threshold           = 20\n', 'threshold           = 0\n'],
    ['credit alarm on every class', 'count               = startswith(local.db_instance_class, "db.t") ? 1 : 0', 'count               = 1'],
    ['memory alarm inverted', 'metric_name         = "FreeableMemory"\n  statistic           = "Minimum"\n  period              = 300\n  evaluation_periods  = 3\n  datapoints_to_alarm = 3\n  threshold           = 134217728\n  comparison_operator = "LessThanThreshold"', 'metric_name         = "FreeableMemory"\n  statistic           = "Minimum"\n  period              = 300\n  evaluation_periods  = 3\n  datapoints_to_alarm = 3\n  threshold           = 134217728\n  comparison_operator = "GreaterThanThreshold"'],
    ['worker memory alarm dropped', '    worker-memory-high = { service = aws_ecs_service.worker[0].name, metric = "MemoryUtilization", what = "memory" }\n', ''],
    ['no recovery notice on the notifier', '  ok_actions          = [aws_sns_topic.audit_alarms.arn]\n  dimensions = {\n    FunctionName', '  dimensions = {\n    FunctionName'],
    ['latency alarm removed', 'resource "aws_cloudwatch_metric_alarm" "database_read_latency_high"', 'resource "aws_cloudwatch_metric_alarm" "database_read_latency_renamed"'],
  ]) {
    assert.ok(tf.includes(from), `the control for "${why}" must match the real text (it does not: fix the control)`);
    assert.notDeepEqual(resourceAlarmProblems(tf.replace(from, to)), [], why);
  }
});
