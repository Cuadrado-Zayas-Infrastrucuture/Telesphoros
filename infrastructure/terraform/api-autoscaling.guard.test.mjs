// Guards for the API's autoscaling (api-autoscaling.tf). Imported by guard.test.mjs, so `pnpm test:infra` runs it.
// Like the other guards it reads Terraform TEXT: what AWS does with it is planned by the runs in profiles.tftest.hcl. `autoscalingProblems`
// returns what is wrong with copies of the texts (empty when nothing is); the tests run it on the real files and on broken copies, so every rule
// has been seen to fail.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (path) => {
  const url = new URL(path, import.meta.url);
  return existsSync(url) ? readFileSync(url, 'utf8') : '';
};
const real = {
  scaling: read('./api-autoscaling.tf'),
  api: read('./api-compute.tf'),
  connections: read('./database-connections.tf'),
};

const squash = (s) => s.replace(/\s+/g, ' ');
const code = (text) => text.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');

/** The text of the first `header { ... }` block, by brace matching ('' when there is none). */
function block(text, header) {
  const m = new RegExp(header).exec(text);
  if (!m) return '';
  let depth = 0;
  for (let i = text.indexOf('{', m.index); i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return text.slice(m.index, i + 1);
  }
  return '';
}

export function autoscalingProblems(t = real) {
  const problems = [];
  const need = (ok, message) => {
    if (!ok) problems.push(message);
  };
  const tf = squash(code(t.scaling));
  need(tf.length > 0, 'api-autoscaling.tf must exist');

  // The ceiling: null means no autoscaling (the ceiling is the floor), and a ceiling under the floor is refused.
  const max = squash(block(code(t.scaling), 'variable "api_max_count"'));
  need(/default = null\b/.test(max), 'api_max_count must default to null (no autoscaling)');
  need(max.includes('coalesce(var.api_max_count, 0) >= 1 && coalesce(var.api_max_count, 0) <= 10'), 'api_max_count must be 1 to 10, the bounds of api_desired_count');
  need(max.includes('coalesce(var.api_max_count, var.api_desired_count) >= var.api_desired_count'), 'api_max_count below api_desired_count must be refused');
  need(tf.includes('api_max_tasks = coalesce(var.api_max_count, var.api_desired_count)'), 'local.api_max_tasks must fall back to api_desired_count');

  // The scalable target exists whenever the service does, between the floor and the ceiling.
  const target = squash(block(code(t.scaling), 'resource "aws_appautoscaling_target" "api"'));
  need(/count = local\.api_service_count\b/.test(target), 'the scalable target must exist exactly when the API service does');
  need(target.includes('service_namespace = "ecs"') && target.includes('scalable_dimension = "ecs:service:DesiredCount"'), 'the scalable target must scale the ECS service desired count');
  need(target.includes('resource_id = "service/${aws_ecs_cluster.api[0].name}/${aws_ecs_service.api[0].name}"'), 'the scalable target must name this cluster and service');
  need(/min_capacity = var\.api_desired_count\b/.test(target), 'the floor must be api_desired_count');
  need(/max_capacity = local\.api_max_tasks\b/.test(target), 'the ceiling must be local.api_max_tasks');

  // The policy exists only when the ceiling is above the floor, and tracks CPU.
  const policy = squash(block(code(t.scaling), 'resource "aws_appautoscaling_policy" "api_cpu"'));
  need(policy.includes('count = local.api_service_count == 1 && local.api_max_tasks > var.api_desired_count ? 1 : 0'), 'the policy must exist only when api_max_count is above api_desired_count');
  need(policy.includes('policy_type = "TargetTrackingScaling"') && policy.includes('predefined_metric_type = "ECSServiceAverageCPUUtilization"'), 'the policy must track the service average CPU');
  need(/target_value = var\.api_scale_cpu_target\b/.test(policy), 'the policy must target api_scale_cpu_target');
  need(/scale_in_cooldown = \d+/.test(policy) && /scale_out_cooldown = \d+/.test(policy), 'the policy must state both cooldowns');
  need(/disable_scale_in = false\b/.test(policy), 'the policy must scale back in');

  // Terraform must not undo a scale-out on the next apply: the target owns the count once the service exists.
  const service = squash(block(code(t.api), 'resource "aws_ecs_service" "api"'));
  need(/lifecycle \{[^}]*ignore_changes = \[desired_count\]/.test(service), 'the API service must ignore desired_count changes (the scalable target owns it)');
  need(/desired_count = var\.api_desired_count\b/.test(service), 'the API service must still start at api_desired_count');

  // The connection budget counts the API at its ceiling, not its floor.
  const connections = squash(code(t.connections));
  need(connections.includes('local.api_service_count * local.api_max_tasks * (var.api_db_pool_max + 3)'), 'the connection budget must count the API at local.api_max_tasks');
  need(!connections.includes('var.api_desired_count *'), 'the connection budget must not count the API at api_desired_count');
  // Each login's own limit (login_connection_demand) counts the API's logins at the ceiling too.
  need(connections.includes('app = ceil(local.api_service_count * local.api_max_tasks * var.api_db_pool_max *'), 'the app login demand must count the API at local.api_max_tasks');
  need(connections.includes('verifier = ceil(local.api_service_count * local.api_max_tasks * 3 *'), 'the verifier login demand must count the API at local.api_max_tasks');
  return problems;
}

test('the API autoscaling text has no problems (and the scan found the files)', () => {
  assert.ok(real.api.length > 500 && real.connections.length > 500);
  assert.deepEqual(autoscalingProblems(), []);
});

test('the API autoscaling guard reports each way the texts could drift (controls)', () => {
  const broken = (key, from, to) => {
    assert.ok(real[key].includes(from), `the control's text must exist: ${from}`);
    return autoscalingProblems({ ...real, [key]: real[key].replace(from, to) });
  };
  const cases = [
    ['scaling', 'max_capacity       = local.api_max_tasks', 'max_capacity       = 10', 'ceiling must be'],
    ['scaling', 'min_capacity       = var.api_desired_count', 'min_capacity       = 1', 'floor must be'],
    ['scaling', 'local.api_max_tasks > var.api_desired_count ? 1 : 0', 'true ? 1 : 0', 'only when api_max_count'],
    ['scaling', '"ECSServiceAverageCPUUtilization"', '"ALBRequestCountPerTarget"', 'average CPU'],
    ['scaling', 'disable_scale_in   = false', 'disable_scale_in   = true', 'scale back in'],
    ['scaling', 'coalesce(var.api_max_count, var.api_desired_count) >= var.api_desired_count', 'true', 'below api_desired_count'],
    ['scaling', 'api_max_tasks = coalesce(var.api_max_count, var.api_desired_count)', 'api_max_tasks = 10', 'fall back'],
    ['api', 'ignore_changes = [desired_count]', 'ignore_changes = []', 'ignore desired_count'],
    ['connections', 'local.api_service_count * local.api_max_tasks * (var.api_db_pool_max + 3)', 'local.api_service_count * var.api_desired_count * (var.api_db_pool_max + 3)', 'at local.api_max_tasks'],
    ['connections', 'local.api_service_count * local.api_max_tasks * var.api_db_pool_max *', 'local.api_service_count * var.api_desired_count * var.api_db_pool_max *', 'app login'],
    ['connections', 'local.api_service_count * local.api_max_tasks * 3 *', 'local.api_service_count * var.api_desired_count * 3 *', 'verifier login'],
  ];
  for (const [key, from, to, expected] of cases) {
    const problems = broken(key, from, to);
    assert.ok(problems.some((p) => p.includes(expected)), `${key}: "${from}" -> "${to}" must report "${expected}", got ${JSON.stringify(problems)}`);
  }
  assert.ok(autoscalingProblems({ ...real, scaling: '' }).some((p) => p.includes('must exist')), 'a missing file must be reported');
});
