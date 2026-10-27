// Guards for the database instance alarms (database-alarms.tf). Imported by guard.test.mjs, so `pnpm test:infra` runs it.
// Like the other guards it reads Terraform TEXT: it cannot prove what AWS will do once applied. `databaseAlarmProblems` returns what is wrong with a copy of the text
// (empty when nothing is); the tests run it on the real file and on deliberately broken copies, so every rule has been seen to fail.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const alarms = read('./database-alarms.tf');
const database = read('./database.tf');

const squash = (s) => s.replace(/[ \t]+/g, ' ');
const code = (text) => text.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');

function blocks(text, header) {
  const found = [];
  const re = new RegExp(header, 'g');
  for (let m = re.exec(text); m; m = re.exec(text)) {
    let depth = 0;
    let i = text.indexOf('{', m.index);
    const start = i;
    for (; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}' && --depth === 0) break;
    }
    found.push(text.slice(start, i + 1));
  }
  return found;
}

const EXPECTED = {
  database_low_storage: { metric: 'FreeStorageSpace', statistic: 'Minimum', operator: 'LessThanThreshold', threshold: '4294967296', period: '300', evaluation: '3', missing: 'breaching' },
  database_cpu_high: { metric: 'CPUUtilization', statistic: 'Average', operator: 'GreaterThanThreshold', threshold: '80', period: '300', evaluation: '3', missing: 'notBreaching' },
  database_connections_high: { metric: 'DatabaseConnections', statistic: 'Maximum', operator: 'GreaterThanThreshold', threshold: 'floor(coalesce(local.connection_budget, 0) * 0.8)', period: '300', evaluation: '1', missing: 'notBreaching' },
};

export function databaseAlarmProblems(text, databaseText = database) {
  const problems = [];
  const need = (ok, message) => { if (!ok) problems.push(message); };
  const has = (haystack, s) => squash(code(haystack)).includes(squash(s));
  const one = (header) => blocks(code(text), header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))[0] ?? '';

  need(text.length > 2000, 'the scan must find the file (a floor, so an empty read cannot pass)');
  need(/resource "aws_db_instance" "main"/.test(code(databaseText)) && has(databaseText, 'identifier = local.name'), 'the instance the alarms watch must still be aws_db_instance.main');
  for (const [name, e] of Object.entries(EXPECTED)) {
    const b = one(`resource "aws_cloudwatch_metric_alarm" "${name}"`);
    need(b !== '', `${name} is missing`);
    need(has(b, 'namespace = "AWS/RDS"') && has(b, `metric_name = "${e.metric}"`) && has(b, `statistic = "${e.statistic}"`), `${name} must read ${e.metric} (${e.statistic}) in AWS/RDS`);
    // Whole lines, not substrings: `threshold = 800` must not satisfy `threshold = 80`.
    const line = (key, value) => new RegExp(`^\\s*${key}\\s*=\\s*${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm').test(code(b));
    need(line('period', e.period) && line('evaluation_periods', e.evaluation) && line('threshold', e.threshold) && line('comparison_operator', `"${e.operator}"`), `${name} has the wrong period, evaluation count, threshold or direction`);
    need(has(b, `treat_missing_data = "${e.missing}"`), `${name} must treat missing data as ${e.missing}`);
    need(has(b, 'alarm_actions = [aws_sns_topic.audit_alarms.arn]'), `${name} must notify the audit topic`);
    need(has(b, 'DBInstanceIdentifier = aws_db_instance.main.identifier'), `${name} must watch this database instance`);
  }
  // No data from a database means no report from a database that should be reporting, so for free space it counts as the alarm; for CPU and connections a gap is not a finding.
  return problems;
}

test('the database alarms text has no problems (and the scan found the file)', () => {
  assert.deepEqual(databaseAlarmProblems(alarms), []);
});

test('the database alarms guard reports each way the text could be weakened (controls)', () => {
  const weakened = [
    ['free space watched as an average', 'statistic           = "Minimum"', 'statistic           = "Average"'],
    ['the storage threshold raised past the disk', 'threshold           = 4294967296', 'threshold           = 4'],
    ['free space silence treated as healthy', 'comparison_operator = "LessThanThreshold"\n  treat_missing_data  = "breaching"', 'comparison_operator = "LessThanThreshold"\n  treat_missing_data  = "notBreaching"'],
    ['the storage alarm fires on one period', 'evaluation_periods  = 3\n  datapoints_to_alarm = 3\n  threshold           = 4294967296', 'evaluation_periods  = 1\n  datapoints_to_alarm = 1\n  threshold           = 4294967296'],
    ['the CPU alarm reads a different metric', 'metric_name         = "CPUUtilization"', 'metric_name         = "CPUCreditBalance"'],
    ['the CPU threshold raised to never fire', 'threshold           = 80\n  comparison_operator = "GreaterThanThreshold"\n  treat_missing_data  = "notBreaching"\n  alarm_actions       = [aws_sns_topic.audit_alarms.arn]\n  dimensions = {\n    DBInstanceIdentifier = aws_db_instance.main.identifier\n  }\n}\n\n# Connections', 'threshold           = 800\n  comparison_operator = "GreaterThanThreshold"\n  treat_missing_data  = "notBreaching"\n  alarm_actions       = [aws_sns_topic.audit_alarms.arn]\n  dimensions = {\n    DBInstanceIdentifier = aws_db_instance.main.identifier\n  }\n}\n\n# Connections'],
    ['the connections threshold fixed again', 'threshold           = floor(coalesce(local.connection_budget, 0) * 0.8)', 'threshold           = 80'],
    ['the connections threshold at the whole budget', 'threshold           = floor(coalesce(local.connection_budget, 0) * 0.8)', 'threshold           = floor(coalesce(local.connection_budget, 0) * 1)'],
    ['the connections alarm is removed', 'resource "aws_cloudwatch_metric_alarm" "database_connections_high" {', 'resource "aws_cloudwatch_metric_alarm" "database_connections_high_x" {'],
    ['an alarm tells nobody', 'resource "aws_cloudwatch_metric_alarm" "database_cpu_high" {\n  alarm_name          = "${local.name}-database-cpu-high"\n  alarm_description   = "Database CPU has averaged over 80% for 15 minutes. Look for a runaway query or a deploy surge before resizing the instance."\n  namespace           = "AWS/RDS"\n  metric_name         = "CPUUtilization"\n  statistic           = "Average"\n  period              = 300\n  evaluation_periods  = 3\n  datapoints_to_alarm = 3\n  threshold           = 80\n  comparison_operator = "GreaterThanThreshold"\n  treat_missing_data  = "notBreaching"\n  alarm_actions       = [aws_sns_topic.audit_alarms.arn]', 'resource "aws_cloudwatch_metric_alarm" "database_cpu_high" {\n  alarm_name          = "${local.name}-database-cpu-high"\n  alarm_description   = "Database CPU has averaged over 80% for 15 minutes. Look for a runaway query or a deploy surge before resizing the instance."\n  namespace           = "AWS/RDS"\n  metric_name         = "CPUUtilization"\n  statistic           = "Average"\n  period              = 300\n  evaluation_periods  = 3\n  datapoints_to_alarm = 3\n  threshold           = 80\n  comparison_operator = "GreaterThanThreshold"\n  treat_missing_data  = "notBreaching"\n  alarm_actions       = []'],
    ['an alarm watches no instance', 'DBInstanceIdentifier = aws_db_instance.main.identifier', 'DBInstanceIdentifier = "elsewhere"'],
  ];
  for (const [name, from, to] of weakened) {
    assert.ok(alarms.includes(from), `the control for "${name}" must match the real text (it does not: fix the control)`);
    assert.ok(databaseAlarmProblems(alarms.replace(from, to)).length > 0, `a weakened text must be reported: ${name}`);
  }
  assert.ok(databaseAlarmProblems(alarms, database.replace('identifier     = local.name', 'identifier     = "other"')).length > 0, 'a renamed instance must be reported');
  assert.ok(databaseAlarmProblems('').length > 0, 'an empty read must be reported (a floor)');
  assert.deepEqual(databaseAlarmProblems(alarms), []); // control: the unchanged text is clean
});
