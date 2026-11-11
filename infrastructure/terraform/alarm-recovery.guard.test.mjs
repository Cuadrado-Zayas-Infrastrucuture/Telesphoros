// Every CloudWatch metric alarm also says when it clears (observability plan A1, founder decision OB1, 2026-11-11). Imported by guard.test.mjs, so
// `pnpm test:infra` runs it. An alarm with no `ok_actions` sends one email when it fires and nothing when it recovers, so a fault that fired and
// cleared reads the same as one still firing. Like the other guards it reads Terraform TEXT, not what AWS does once applied.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const here = new URL('.', import.meta.url);
const files = readdirSync(here).filter((f) => f.endsWith('.tf'));
const code = (text) => text.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');

/** Every `resource "aws_cloudwatch_metric_alarm" "<name>"` block in TEXT, with its name. */
function alarms(text) {
  const found = [];
  const re = /resource "aws_cloudwatch_metric_alarm" "([a-z0-9_]+)"/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    let depth = 0;
    let i = text.indexOf('{', m.index);
    const start = i;
    for (; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}' && --depth === 0) break;
    }
    found.push({ name: m[1], body: text.slice(start, i + 1) });
  }
  return found;
}

const setting = (body, key) => new RegExp(`^\\s*${key}\\s*=\\s*(.+)$`, 'm').exec(body)?.[1].trim();

/** What is wrong with TEXT (empty when nothing is): an alarm that notifies on firing must notify the same targets when it clears. */
export function alarmRecoveryProblems(text) {
  const problems = [];
  for (const { name, body } of alarms(code(text))) {
    const fire = setting(body, 'alarm_actions');
    const clear = setting(body, 'ok_actions');
    if (!fire) problems.push(`${name} notifies nobody when it fires`);
    else if (clear !== fire) problems.push(`${name} must send ok_actions to the same targets as alarm_actions (${clear ?? 'none'} vs ${fire})`);
  }
  return problems;
}

const all = files.map((f) => readFileSync(new URL(f, here), 'utf8')).join('\n');

test('every metric alarm notifies the same targets when it clears as when it fires', () => {
  const count = alarms(code(all)).length;
  assert.ok(count >= 30, `expected the full alarm set, found ${count}`);
  assert.deepEqual(alarmRecoveryProblems(all), []);
});

test('the recovery guard reports each way the text could be weakened (controls)', () => {
  const one = 'resource "aws_cloudwatch_metric_alarm" "x" {\n  alarm_actions = [aws_sns_topic.audit_alarms.arn]\n  ok_actions    = [aws_sns_topic.audit_alarms.arn]\n}\n';
  assert.deepEqual(alarmRecoveryProblems(one), [], 'control: a correct alarm passes');
  for (const [why, broken, expected] of [
    ['no recovery notice', one.replace(/  ok_actions.*\n/, ''), /x must send ok_actions .*none/],
    ['a recovery notice to somewhere else', one.replace('ok_actions    = [aws_sns_topic.audit_alarms.arn]', 'ok_actions    = []'), /x must send ok_actions/],
    ['a commented-out recovery notice', one.replace('  ok_actions', '  # ok_actions'), /x must send ok_actions .*none/],
    ['an alarm that notifies nobody', one.replace(/  alarm_actions.*\n/, ''), /x notifies nobody/],
  ]) {
    const found = alarmRecoveryProblems(broken);
    assert.equal(found.length, 1, why);
    assert.match(found[0], expected, why);
  }
});
