// Guards for the API's compute (api-compute.tf). Imported by guard.test.mjs, so `pnpm test:infra` runs it.
// Like the other guards it reads Terraform TEXT: it cannot prove what AWS will do once applied. `apiComputeProblems` returns what is wrong with a
// copy of the text (empty when nothing is); the tests run it on the real file and on deliberately broken copies, so every rule has been seen to fail.
//
// One check goes beyond text: the task's environment (as Terraform would write it) is handed to the APPLICATION'S OWN `loadEnv`, with the two secrets
// filled with placeholders, and must be accepted as a production configuration. That needs Node's built-in TypeScript support (22.18 or newer; CI pins 22.22).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const compute = read('./api-compute.tf');
const ledgerSource = read('../../apps/backend/src/ledger/ledger-monitor.ts');
const logShapeSpec = read('../../apps/backend/src/log-shape.spec.ts');
const loggerOptions = read('../../apps/backend/src/logger-options.ts');
const appModule = read('../../apps/backend/src/app.module.ts');
const { loadEnv } = await import('../../apps/backend/src/config/env.ts').catch((error) => {
  throw new Error(`the application's own configuration loader could not be imported (this guard needs Node 22.18 or newer): ${error.message}`);
});

const squash = (s) => s.replace(/[ \t]+/g, ' ');
/** Terraform text without comment lines, so a rule is checked against what is configured and not against what is said about it. */
const code = (text) => text.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');

/** Every `block { ... }` whose header matches, by brace matching. */
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

const PLACEHOLDERS = {
  'tostring(local.api_port)': '3000',
  'var.region': 'us-east-2',
  'aws_cognito_user_pool.main.id': 'us-east-2_AbCdEfGhI',
  'aws_cognito_user_pool_client.spa.id': 'client-id',
  'aws_s3_bucket.reports.bucket': 'telesphoros-staging-reports-123456789012',
  'join(",", var.api_cors_origins)': 'https://app.example.com',
  'local.api_build': 'sha256-abababababab',
};
const SECRET_PLACEHOLDERS = {
  DATABASE_URL: 'postgres://app_login@db.example:5432/telesphoros?sslmode=require',
  LEDGER_VERIFIER_DATABASE_URL: 'postgres://verifier_login@db.example:5432/telesphoros?sslmode=require',
};
/** Values that must never be plain environment: secrets, and anything the production start-up refuses. */
const FORBIDDEN_ENVIRONMENT = ['DATABASE_URL', 'LEDGER_VERIFIER_DATABASE_URL', 'DATABASE_MIGRATOR_URL', 'DATABASE_ADMIN_URL', 'JWT_SECRET', 'LAB_REPORT_PIPELINE', 'COGNITO_ISSUER', 'COGNITO_JWKS_URI', 'S3_ENDPOINT', 'KNOWLEDGE_DIR', 'LAB_REPORT_FIXTURES_DIR', 'LAB_REPORT_PIPELINE'];

/** The task environment as Terraform would write it: name -> value, plus problems for anything this guard cannot evaluate. */
function environmentOf(text, problems) {
  const block = blocks(text, 'api_environment = ')[0] ?? '';
  const env = {};
  for (const m of block.matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.+)$/gm)) {
    const expr = squash(m[2]).trim();
    if (/^".*"$/.test(expr) && !expr.includes('${')) env[m[1]] = expr.slice(1, -1);
    else if (expr in PLACEHOLDERS) env[m[1]] = PLACEHOLDERS[expr];
    else problems.push(`the environment value for ${m[1]} (${expr}) is not one this guard knows how to evaluate: teach it deliberately`);
  }
  return env;
}

/** The statements of an IAM policy document block: [{ sid, actions, resources, body }]. */
function statements(doc) {
  return blocks(doc, 'statement \\{').map((body) => ({
    body,
    sid: /sid\s*=\s*"([^"]+)"/.exec(body)?.[1] ?? '',
    actions: squash(/^\s*actions\s*=\s*(.+)$/m.exec(body)?.[1] ?? ''),
    resources: squash(/^\s*resources\s*=\s*(.+)$/m.exec(body)?.[1] ?? ''),
  }));
}

/** What is wrong with the API-compute Terraform text `tf` (and the application sources it must agree with), as a list of sentences. */
export function apiComputeProblems(tf, sources = {}) {
  const ledger = sources.ledger ?? ledgerSource;
  const spec = sources.spec ?? logShapeSpec;
  const options = sources.options ?? loggerOptions;
  const moduleSource = sources.appModule ?? appModule;
  const problems = [];
  const text = code(tf);
  const need = (condition, why) => {
    if (!condition) problems.push(why);
  };
  const has = (haystack, fragment) => squash(code(haystack)).includes(squash(fragment));
  const one = (header) => blocks(text, header)[0] ?? '';

  // Counting: the foundations by the one switch; the task definitions, the service and its alarms also by the image.
  need(has(text, 'api_service_count = var.enable_api_hosting && var.api_image != "" ? 1 : 0'), 'api_service_count must need the switch and an image');
  const resources = [...text.matchAll(/^resource "([^"]+)" "([^"]+)"/gm)];
  need(resources.length >= 21, 'the scan must find the resources (a floor, so an empty read cannot pass)');
  const SERVICE_ONLY = new Set(['aws_ecs_task_definition.api', 'aws_ecs_task_definition.api_migrate', 'aws_ecs_service.api', 'aws_cloudwatch_metric_alarm.api_unhealthy_targets', 'aws_cloudwatch_metric_alarm.api_target_5xx', 'aws_cloudwatch_metric_alarm.api_running_tasks']);
  for (const [header, type, name] of resources) {
    const b = blocks(text, header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))[0] ?? '';
    const want = SERVICE_ONLY.has(`${type}.${name}`) ? 'local.api_service_count' : 'local.api_count';
    need(has(b, `count = ${want}`), `${type}.${name} must be counted by ${want}`);
  }

  // Secrets: containers only, encrypted, no value anywhere.
  need(!/aws_secretsmanager_secret_version|secret_string|secret_binary/.test(text), 'no secret value may be in Terraform (no secret version, no secret string)');
  for (const name of ['api_database_url', 'api_ledger_verifier_url', 'api_migrator_url']) need(has(one(`resource "aws_secretsmanager_secret" "${name}"`), 'kms_key_id = aws_kms_key.data.arn'), `the ${name} secret must be encrypted with the data key`);

  // Roles.
  need(!text.includes('AmazonECSTaskExecutionRolePolicy'), 'the broad managed execution policy must not be used');
  need(!/aws_iam_role_policy" "api_task"/.test(text) && !/iam:PassRole/.test(text), 'the task role must carry the app_runtime policy and nothing of its own');
  need(has(one('resource "aws_iam_role_policy_attachment" "api_task_runtime"'), 'policy_arn = aws_iam_policy.app_runtime.arn') && has(one('resource "aws_iam_role_policy_attachment" "api_task_runtime"'), 'role = aws_iam_role.api_task[0].name'), 'the task role must have the app_runtime policy attached');
  const assume = one('data "aws_iam_policy_document" "api_ecs_assume"');
  need(has(assume, 'identifiers = ["ecs-tasks.amazonaws.com"]') && has(assume, 'variable = "aws:SourceAccount"'), 'the roles must be assumable by ECS tasks of this account only');
  for (const role of ['api_task', 'api_execution_service', 'api_execution_migrate']) need(has(one(`resource "aws_iam_role" "${role}"`), 'assume_role_policy = data.aws_iam_policy_document.api_ecs_assume.json'), `the ${role} role must use the ECS-only trust`);
  for (const [doc, secrets, other] of [
    ['api_execution_service', ['api_database_url[0].arn', 'api_ledger_verifier_url[0].arn'], 'api_migrator_url'],
    ['api_execution_migrate', ['api_migrator_url[0].arn'], 'api_database_url'],
  ]) {
    const body = one(`data "aws_iam_policy_document" "${doc}"`);
    const read = statements(body).find((s) => s.actions.includes('secretsmanager:GetSecretValue'));
    need(read !== undefined, `${doc} must read its secrets`);
    for (const ref of secrets) need(read?.resources.includes(`aws_secretsmanager_secret.${ref}`), `${doc} must be able to read ${ref}`);
    need(read ? !read.resources.includes(other) : false, `${doc} must not be able to read ${other}`);
    need(read ? (read.resources.match(/aws_secretsmanager_secret\./g) ?? []).length === secrets.length : false, `${doc} must read exactly its own secrets`);
    const decrypt = statements(body).find((s) => s.actions.includes('kms:Decrypt'));
    need(decrypt !== undefined && has(decrypt.body, 'variable = "kms:ViaService"') && has(decrypt.body, 'secretsmanager.${var.region}.amazonaws.com') && decrypt.resources.includes('aws_kms_key.data.arn'), `${doc} must decrypt only through Secrets Manager with the data key`);
  }
  const common = statements(one('data "aws_iam_policy_document" "api_execution_common"'));
  const open = common.filter((s) => s.resources.includes('"*"'));
  need(open.length === 1 && open[0].actions === '["ecr:GetAuthorizationToken"]', 'the only statement open to every resource may be the registry login');
  need(common.some((s) => s.resources.includes('local.api_repository') && s.actions.includes('ecr:BatchGetImage')), 'image pulls must be limited to the one repository');
  need(common.some((s) => s.resources.includes(':log-group:${local.api_log_group}:*') && s.actions.includes('logs:PutLogEvents')), 'log writes must be limited to the API log group');
  for (const doc of ['api_execution_service', 'api_execution_migrate']) need(has(one(`data "aws_iam_policy_document" "${doc}"`), 'source_policy_documents = [data.aws_iam_policy_document.api_execution_common.json]'), `${doc} must build on the common statements`);

  // The service task definition.
  const task = one('resource "aws_ecs_task_definition" "api"');
  need(has(task, 'network_mode = "awsvpc"') && has(task, 'requires_compatibilities = ["FARGATE"]'), 'the task must be Fargate with awsvpc networking');
  need(has(task, 'task_role_arn = aws_iam_role.api_task[0].arn') && has(task, 'execution_role_arn = aws_iam_role.api_execution_service[0].arn'), 'the task must use the task role and the service execution role');
  need(has(task, 'image = var.api_image'), 'the task must run the digest-pinned image variable');
  need(has(task, 'readonlyRootFilesystem = true'), 'the root filesystem must be read-only');
  need(has(task, 'user = local.api_user') && /api_user\s*=\s*"[1-9][0-9]+"/.test(text), 'the container must run as a non-root numeric user');
  need(has(task, 'stopTimeout = 30'), 'the stop timeout must give the application time to drain');
  need(has(task, 'environment = [for name, value in local.api_environment : { name = name, value = value }]'), 'the environment must come from local.api_environment');
  need(has(task, '"awslogs-group" = aws_cloudwatch_log_group.api[0].name') && has(task, 'logDriver = "awslogs"'), 'logs must go to the API log group');
  need(has(task, 'name = "DATABASE_URL", valueFrom = aws_secretsmanager_secret.api_database_url[0].arn') && has(task, 'name = "LEDGER_VERIFIER_DATABASE_URL", valueFrom = aws_secretsmanager_secret.api_ledger_verifier_url[0].arn'), 'the two database logins must be injected from their secrets');
  need(!has(task, 'DATABASE_MIGRATOR_URL'), 'the service must never hold the migrator login');
  need(has(task, 'condition = length(var.api_cors_origins) >= 1'), 'the task must require at least one CORS origin');

  // The one-off migration task.
  const migrate = one('resource "aws_ecs_task_definition" "api_migrate"');
  need(!has(migrate, 'task_role_arn'), 'the migration task must have no task role (it reaches the database only)');
  need(has(migrate, 'execution_role_arn = aws_iam_role.api_execution_migrate[0].arn'), 'the migration task must use its own execution role');
  need(has(migrate, 'command = ["node", "dist/db/cli.js", "migrate", "up"]'), 'the migration task must run the migrate command');
  need(has(migrate, 'name = "DATABASE_MIGRATOR_URL", valueFrom = aws_secretsmanager_secret.api_migrator_url[0].arn'), 'the migration task must get the migrator login from its secret');
  need(has(migrate, 'readonlyRootFilesystem = true') && has(migrate, 'user = local.api_user'), 'the migration task must be read-only and non-root too');
  need(has(text, 'family = "${local.name}-api-migrate"') && !/aws_ecs_service" "api_migrate/.test(text), 'the migration task must be a task definition only, never a service');

  // The environment, judged by the application's own start-up rules.
  const env = environmentOf(text, problems);
  for (const key of FORBIDDEN_ENVIRONMENT) need(!(key in env), `${key} must not be a plain environment value`);
  need(env.TRUST_PROXY_HOPS === '1', 'TRUST_PROXY_HOPS must be 1: exactly one proxy (the load balancer) sits in front of the API');
  need(env.PORT === '3000', 'PORT must be the port the load balancer sends to');
  try {
    loadEnv({ ...env, ...SECRET_PLACEHOLDERS });
  } catch (error) {
    problems.push(`the application refuses this task environment: ${String(error.message).replace(/\s+/g, ' ').slice(0, 300)}`);
  }

  // The service.
  const service = one('resource "aws_ecs_service" "api"');
  need(has(service, 'launch_type = "FARGATE"') && has(service, 'desired_count = var.api_desired_count'), 'the service must be Fargate with the desired count variable');
  need(has(service, 'enable_execute_command = false'), 'no shell may be opened into a task');
  need(has(service, 'assign_public_ip = false') && has(service, 'subnets = var.private_subnet_ids') && has(service, 'security_groups = [aws_security_group.api_tasks[0].id]'), 'tasks must run in the private subnets, with no public address, in the tasks security group');
  need(has(service, 'enable = true') && has(service, 'rollback = true'), 'a failed deployment must roll back (circuit breaker)');
  need(has(service, 'deployment_minimum_healthy_percent = 100') && has(service, 'deployment_maximum_percent = 200'), 'a deployment must never reduce healthy capacity');
  need(has(service, 'target_group_arn = aws_lb_target_group.api[0].arn') && has(service, 'container_name = local.api_container') && has(service, 'container_port = local.api_port'), 'the service must register with the API target group on the task port');
  need(has(task, 'name = local.api_container'), 'the task container name must match the one the service registers');
  need(has(service, 'condition = var.environment != "production" || var.api_desired_count >= 2'), 'production must run at least two tasks');

  // Logs and their key.
  const key = one('data "aws_iam_policy_document" "api_logs_key"');
  need(!/identifiers\s*=\s*\["\*"\]/.test(key), 'the log key policy must not name a wildcard principal');
  need(has(key, 'values = ["arn:aws:logs:${var.region}:${local.audit_account_id}:log-group:${local.api_log_group}"]'), 'the log service may use the key only for the API log group');
  need(has(one('resource "aws_kms_key" "api_logs"'), 'enable_key_rotation = true'), 'the log key must rotate');
  const group = one('resource "aws_cloudwatch_log_group" "api"');
  need(has(group, 'kms_key_id = aws_kms_key.api_logs[0].arn') && has(group, 'retention_in_days = var.api_log_retention_days') && has(group, 'name = local.api_log_group'), 'the log group must be encrypted with its own key and use the retention variable');
  need(has(one('variable "api_log_retention_days"'), 'condition     = var.api_log_retention_days >= 90'), 'log retention must keep a floor of 90 days');

  // Variables.
  const image = one('variable "api_image"');
  need(has(image, 'default     = ""') && has(image, '@sha256:[0-9a-f]{64}$'), 'the image must default to empty and be refused unless pinned by digest');
  need(has(one('variable "api_cors_origins"'), 'startswith(o, "https://")'), 'CORS origins must be https');

  // The alarms.
  const filter = one('resource "aws_cloudwatch_log_metric_filter" "api_ledger_compromised"');
  need(has(filter, 'pattern = "{ $.event = \\"ledger-compromised\\" }"'), 'the ledger alarm must match the top-level event field');
  need(has(filter, 'log_group_name = aws_cloudwatch_log_group.api[0].name'), 'the ledger filter must read the API log group');
  need(/event:\s*'ledger-compromised'/.test(ledger), 'the application must still log the event the alarm looks for (ledger-monitor.ts)');
  need(/ledger-compromised/.test(spec) && /pinoHttpOptions/.test(spec), 'the log-shape test must keep pinning that the real logger options write the event at the top level');
  need(/nestedKey|formatters/.test(options) === false, 'the logger options must not nest or reshape logged objects');
  need(/pinoHttp:\s*pinoHttpOptions\(config\)/.test(moduleSource), 'the application must use the shared logger options');
  const ledgerAlarm = one('resource "aws_cloudwatch_metric_alarm" "api_ledger_compromised"');
  need(has(ledgerAlarm, 'metric_name = "LedgerCompromised"') && has(ledgerAlarm, 'comparison_operator = "GreaterThanOrEqualToThreshold"') && has(ledgerAlarm, 'threshold = 1') && has(ledgerAlarm, 'period = 60'), 'one occurrence of the ledger event must raise the alarm within a minute');
  need(has(ledgerAlarm, 'treat_missing_data = "notBreaching"'), 'silence is normal for the ledger alarm');
  for (const alarm of ['api_ledger_compromised', 'api_unhealthy_targets', 'api_target_5xx', 'api_running_tasks']) need(has(one(`resource "aws_cloudwatch_metric_alarm" "${alarm}"`), 'alarm_actions = [aws_sns_topic.audit_alarms.arn]'), `the ${alarm} alarm must notify the audit topic`);
  const unhealthy = one('resource "aws_cloudwatch_metric_alarm" "api_unhealthy_targets"');
  need(has(unhealthy, 'metric_name = "UnHealthyHostCount"') && has(unhealthy, 'threshold = 0') && has(unhealthy, 'comparison_operator = "GreaterThanThreshold"'), 'any unhealthy task must raise the unhealthy-targets alarm');
  need(has(one('resource "aws_cloudwatch_metric_alarm" "api_target_5xx"'), 'metric_name = "HTTPCode_Target_5XX_Count"'), 'server errors must raise the 5xx alarm');
  const running = one('resource "aws_cloudwatch_metric_alarm" "api_running_tasks"');
  need(has(running, 'threshold = var.api_desired_count') && has(running, 'comparison_operator = "LessThanThreshold"') && has(running, 'treat_missing_data = "breaching"'), 'too few running tasks (or no report at all) must raise the running-tasks alarm');

  // The cluster.
  need(has(one('resource "aws_ecs_cluster" "api"'), 'value = "enabled"'), 'Container Insights must be on (the running-tasks alarm reads it)');
  for (const name of ['api_log_group', 'api_secret_arns', 'api_cluster_name', 'api_migrate_task_family']) need(has(text, `output "${name}"`), `output ${name} is missing`);
  return problems;
}

test('the API compute text has no problems (and the scan found the file: a floor, so an empty read cannot pass)', () => {
  assert.ok(compute.length > 14000 && compute.includes('resource "aws_ecs_service" "api"'));
  assert.deepEqual(apiComputeProblems(compute), []);
});

test("the application's own configuration loader accepts the task environment, and refuses a broken one (control)", () => {
  const problems = [];
  const env = environmentOf(code(compute), problems);
  assert.deepEqual(problems, []);
  assert.ok(Object.keys(env).length >= 15);
  assert.doesNotThrow(() => loadEnv({ ...env, ...SECRET_PLACEHOLDERS }));
  assert.throws(() => loadEnv({ ...env, ...SECRET_PLACEHOLDERS, TRUST_PROXY_HOPS: undefined }), /TRUST_PROXY_HOPS/);
  assert.throws(() => loadEnv({ ...env, ...SECRET_PLACEHOLDERS, LAB_REPORT_PIPELINE: 'enabled' }), /LAB_REPORT_PIPELINE/);
  assert.throws(() => loadEnv({ ...env, AUTH_VERIFIER: 'cognito' }), /LEDGER_VERIFIER_DATABASE_URL/);
});

const envLine = (key, value) => `${key.padEnd(33)} = ${value}`;

test('the API compute guard reports each way the text could be weakened (controls)', () => {
  const weakened = [
    ['service count ignores the image', 'api_service_count = var.enable_api_hosting && var.api_image != "" ? 1 : 0', 'api_service_count = var.enable_api_hosting ? 1 : 0'],
    ['a foundation resource not counted', 'resource "aws_ecs_cluster" "api" {\n  count = local.api_count\n', 'resource "aws_ecs_cluster" "api" {\n'],
    ['the service counted by the wrong switch', 'resource "aws_ecs_service" "api" {\n  count                              = local.api_service_count', 'resource "aws_ecs_service" "api" {\n  count                              = local.api_count'],
    ['a secret value in Terraform', 'resource "aws_secretsmanager_secret" "api_migrator_url" {', 'resource "aws_secretsmanager_secret_version" "oops" {\n  count         = local.api_count\n  secret_id     = "x"\n  secret_string = "postgres://x"\n}\n\nresource "aws_secretsmanager_secret" "api_migrator_url" {'],
    ['a secret not encrypted with the data key', 'description = "DATABASE_URL: the application login (member of telesphoros_app only). Value set by hand."\n  kms_key_id  = aws_kms_key.data.arn', 'description = "x"\n  kms_key_id  = "alias/aws/secretsmanager"'],
    ['the broad managed execution policy', 'resource "aws_iam_role_policy" "api_execution_service" {', 'resource "aws_iam_role_policy_attachment" "broad" {\n  count      = local.api_count\n  role       = aws_iam_role.api_execution_service[0].name\n  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"\n}\n\nresource "aws_iam_role_policy" "api_execution_service" {'],
    ['the task role gets its own policy', 'resource "aws_iam_role_policy_attachment" "api_task_runtime" {', 'resource "aws_iam_role_policy" "api_task" {\n  count  = local.api_count\n  name   = "x"\n  role   = aws_iam_role.api_task[0].id\n  policy = "{}"\n}\n\nresource "aws_iam_role_policy_attachment" "api_task_runtime" {'],
    ['the task role loses the app policy', 'policy_arn = aws_iam_policy.app_runtime.arn', 'policy_arn = aws_iam_policy.backup_job.arn'],
    ['trust not limited to this account', 'variable = "aws:SourceAccount"', 'variable = "aws:Other"'],
    ['the service reads the migrator secret', 'resources = [aws_secretsmanager_secret.api_database_url[0].arn, aws_secretsmanager_secret.api_ledger_verifier_url[0].arn]', 'resources = [aws_secretsmanager_secret.api_database_url[0].arn, aws_secretsmanager_secret.api_ledger_verifier_url[0].arn, aws_secretsmanager_secret.api_migrator_url[0].arn]'],
    ['the migration reads a runtime secret', 'resources = [aws_secretsmanager_secret.api_migrator_url[0].arn]', 'resources = [aws_secretsmanager_secret.api_migrator_url[0].arn, aws_secretsmanager_secret.api_database_url[0].arn]'],
    ['secrets decrypted outside Secrets Manager', 'values   = ["secretsmanager.${var.region}.amazonaws.com"]\n    }\n  }\n}\n\ndata "aws_iam_policy_document" "api_execution_migrate"', 'values   = ["s3.${var.region}.amazonaws.com"]\n    }\n  }\n}\n\ndata "aws_iam_policy_document" "api_execution_migrate"'],
    ['pulls from any repository', 'resources = [local.api_repository]', 'resources = ["*"]'],
    ['logs written anywhere', 'resources = ["arn:aws:logs:${var.region}:${local.audit_account_id}:log-group:${local.api_log_group}:*"]', 'resources = ["*"]'],
    ['task not on Fargate networking', 'network_mode             = "awsvpc"\n  cpu                      = var.api_cpu', 'network_mode             = "bridge"\n  cpu                      = var.api_cpu'],
    ['root filesystem writable', 'readonlyRootFilesystem = true\n      stopTimeout            = 30', 'readonlyRootFilesystem = false\n      stopTimeout            = 30'],
    ['container runs as root', 'api_user          = "10001"', 'api_user          = "0"'],
    ['stop timeout dropped', 'stopTimeout            = 30', 'stopTimeout            = 2'],
    ['image is a free variable', 'image                  = var.api_image\n      essential              = true\n      user                   = local.api_user\n      readonlyRootFilesystem = true\n      stopTimeout', 'image                  = "x:latest"\n      essential              = true\n      user                   = local.api_user\n      readonlyRootFilesystem = true\n      stopTimeout'],
    ['the service holds the migrator login', '{ name = "LEDGER_VERIFIER_DATABASE_URL", valueFrom = aws_secretsmanager_secret.api_ledger_verifier_url[0].arn },', '{ name = "LEDGER_VERIFIER_DATABASE_URL", valueFrom = aws_secretsmanager_secret.api_ledger_verifier_url[0].arn },\n        { name = "DATABASE_MIGRATOR_URL", valueFrom = aws_secretsmanager_secret.api_migrator_url[0].arn },'],
    ['the verifier login not injected', '{ name = "LEDGER_VERIFIER_DATABASE_URL", valueFrom = aws_secretsmanager_secret.api_ledger_verifier_url[0].arn },', ''],
    ['no CORS origin required', 'condition     = length(var.api_cors_origins) >= 1', 'condition     = true'],
    ['migration gets a task role', '# No task role: the migration reaches the database only, not S3 or anything else in the account.', 'task_role_arn = aws_iam_role.api_task[0].arn'],
    ['migration uses the service execution role', 'execution_role_arn       = aws_iam_role.api_execution_migrate[0].arn', 'execution_role_arn       = aws_iam_role.api_execution_service[0].arn'],
    ['migration command changed', 'command                = ["node", "dist/db/cli.js", "migrate", "up"]', 'command                = ["node", "dist/main.js"]'],
    ['proxy hops wrong', envLine('TRUST_PROXY_HOPS', '"1"'), envLine('TRUST_PROXY_HOPS', '"2"')],
    ['proxy hops missing', `${envLine('TRUST_PROXY_HOPS', '"1"')}\n`, ''],
    ['shared-secret sign-in', envLine('AUTH_VERIFIER', '"cognito"'), envLine('AUTH_VERIFIER', '"hmac"')],
    ['in-memory store', envLine('STORAGE_DRIVER', '"postgres"'), envLine('STORAGE_DRIVER', '"memory"')],
    ['unencrypted database connection', envLine('DATABASE_SSL', '"require"'), envLine('DATABASE_SSL', '"disable"')],
    ['rate limiting off', envLine('RATE_LIMIT_ENABLED', '"true"'), envLine('RATE_LIMIT_ENABLED', '"false"')],
    ['the pipeline switched on', envLine('RATE_LIMIT_ENABLED', '"true"'), `${envLine('RATE_LIMIT_ENABLED', '"true"')}\n    ${envLine('LAB_REPORT_PIPELINE', '"enabled"')}`],
    ['a secret as plain environment', envLine('RATE_LIMIT_ENABLED', '"true"'), `${envLine('RATE_LIMIT_ENABLED', '"true"')}\n    ${envLine('DATABASE_URL', '"postgres://x"')}`],
    ['an expression the guard cannot evaluate', envLine('BUILD_VERSION', 'local.api_build'), envLine('BUILD_VERSION', 'var.something_new')],
    ['wrong port', envLine('PORT', 'tostring(local.api_port)'), envLine('PORT', '"8080"')],
    ['shell into tasks', 'enable_execute_command             = false', 'enable_execute_command             = true'],
    ['tasks get a public address', 'assign_public_ip = false', 'assign_public_ip = true'],
    ['tasks in the public subnets', 'subnets          = var.private_subnet_ids', 'subnets          = var.public_subnet_ids'],
    ['no rollback', 'rollback = true', 'rollback = false'],
    ['deployment may drop capacity', 'deployment_minimum_healthy_percent = 100', 'deployment_minimum_healthy_percent = 0'],
    ['service registers on another port', 'container_port   = local.api_port\n  }\n\n  depends_on', 'container_port   = 8080\n  }\n\n  depends_on'],
    ['production may run one task', 'condition     = var.environment != "production" || var.api_desired_count >= 2', 'condition     = true'],
    ['log key open to everyone', 'identifiers = ["logs.${var.region}.amazonaws.com"]', 'identifiers = ["*"]'],
    ['log key not tied to the log group', 'log-group:${local.api_log_group}"]', 'log-group:*"]'],
    ['log key not rotating', 'description             = "${local.name} API logs"\n  enable_key_rotation     = true', 'description             = "${local.name} API logs"\n  enable_key_rotation     = false'],
    ['logs unencrypted', 'kms_key_id        = aws_kms_key.api_logs[0].arn', ''],
    ['log retention floor removed', 'condition     = var.api_log_retention_days >= 90', 'condition     = true'],
    ['image tag allowed', '@sha256:[0-9a-f]{64}$", var.api_image))', '", var.api_image))'],
    ['non-https CORS origin allowed', 'startswith(o, "https://")', 'true'],
    ['ledger filter on a nested field', 'pattern        = "{ $.event = \\"ledger-compromised\\" }"', 'pattern        = "{ $.data.event = \\"ledger-compromised\\" }"'],
    ['ledger filter on the wrong event', 'pattern        = "{ $.event = \\"ledger-compromised\\" }"', 'pattern        = "{ $.event = \\"ledger-verification-incomplete\\" }"'],
    ['ledger alarm needs two events', 'threshold           = 1\n  comparison_operator = "GreaterThanOrEqualToThreshold"\n  treat_missing_data  = "notBreaching"\n  alarm_actions       = [aws_sns_topic.audit_alarms.arn]\n  depends_on          = [aws_cloudwatch_log_metric_filter.api_ledger_compromised]', 'threshold           = 2\n  comparison_operator = "GreaterThanOrEqualToThreshold"\n  treat_missing_data  = "notBreaching"\n  alarm_actions       = [aws_sns_topic.audit_alarms.arn]\n  depends_on          = [aws_cloudwatch_log_metric_filter.api_ledger_compromised]'],
    ['ledger alarm notifies nobody', 'alarm_actions       = [aws_sns_topic.audit_alarms.arn]\n  depends_on          = [aws_cloudwatch_log_metric_filter.api_ledger_compromised]', 'alarm_actions       = []\n  depends_on          = [aws_cloudwatch_log_metric_filter.api_ledger_compromised]'],
    ['unhealthy alarm ignores one task', 'threshold           = 0\n  comparison_operator = "GreaterThanThreshold"', 'threshold           = 5\n  comparison_operator = "GreaterThanThreshold"'],
    ['5xx alarm on the wrong metric', 'metric_name         = "HTTPCode_Target_5XX_Count"', 'metric_name         = "RequestCount"'],
    ['running-tasks alarm treats silence as fine', 'treat_missing_data  = "breaching"', 'treat_missing_data  = "notBreaching"'],
    ['running-tasks threshold fixed', 'threshold           = var.api_desired_count', 'threshold           = 0'],
    ['Container Insights off', 'value = "enabled"', 'value = "disabled"'],
    ['output removed', 'output "api_cluster_name"', 'output "api_other"'],
  ];
  for (const [name, from, to] of weakened) {
    assert.ok(compute.includes(from), `the control for "${name}" must match the real text (it does not: fix the control)`);
    assert.ok(apiComputeProblems(compute.replace(from, to)).length > 0, `a weakened text must be reported: ${name}`);
  }
  // The application side of the alarm contract.
  const applicationSide = [
    ['the application stops logging the event', { ledger: ledgerSource.replace("event: 'ledger-compromised'", "event: 'ledger-broken'") }],
    ['the log-shape test is deleted', { spec: '' }],
    ['the logger options start nesting objects', { options: `${loggerOptions}\n  nestedKey: 'payload'` }],
    ['the application stops using the shared options', { appModule: appModule.replace('pinoHttpOptions(config)', '{}') }],
  ];
  for (const [name, sources] of applicationSide) assert.ok(apiComputeProblems(compute, sources).length > 0, `a changed application must be reported: ${name}`);
  assert.deepEqual(apiComputeProblems(compute), []); // control: the unchanged text is clean
});
