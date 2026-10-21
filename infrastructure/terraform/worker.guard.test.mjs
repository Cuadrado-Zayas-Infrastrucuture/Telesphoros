// Guards for the background worker's compute (worker.tf, and the worker_runtime policy in iam.tf). Imported by guard.test.mjs, so `pnpm test:infra` runs it.
// Like the other guards it reads Terraform TEXT: it cannot prove what AWS will do once applied. `workerProblems` returns what is wrong with a copy of the text
// (empty when nothing is); the tests run it on the real files and on deliberately broken copies, so every rule has been seen to fail.
//
// What cannot be judged from text alone is judged in the worker package (apps/worker/src/deploy-contract.test.ts): it hands the environment block below to the
// worker's OWN configuration loader, and checks the alarm patterns against the worker's own log lines.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const worker = read('./worker.tf');
const iam = read('./iam.tf');
const runnerSource = read('../../apps/worker/src/runner.ts');
const filesVerifySource = read('../../apps/worker/src/handlers/files-verify.ts');
const mainSource = read('../../apps/worker/src/main.ts');

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

function statements(doc) {
  return blocks(doc, 'statement \\{').map((body) => ({
    body,
    sid: /sid\s*=\s*"([^"]+)"/.exec(body)?.[1] ?? '',
    actions: squash(/^\s*actions\s*=\s*(.+)$/m.exec(body)?.[1] ?? ''),
    resources: squash(/^\s*resources\s*=\s*(.+)$/m.exec(body)?.[1] ?? ''),
  }));
}

/** What is wrong with the worker Terraform text `tf` (and the iam.tf text `iamTf`, and the worker sources it must agree with), as a list of sentences. */
export function workerProblems(tf, iamTf = iam, sources = {}) {
  const runner = sources.runner ?? runnerSource;
  const filesVerify = sources.filesVerify ?? filesVerifySource;
  const main = sources.main ?? mainSource;
  const problems = [];
  const text = code(tf);
  const need = (condition, why) => {
    if (!condition) problems.push(why);
  };
  const has = (haystack, fragment) => squash(code(haystack)).includes(squash(fragment));
  const one = (header, from = text) => blocks(from, header)[0] ?? '';
  /** A whole line, so `threshold = 900` is not satisfied by `threshold = 90000`. */
  const line = (haystack, fragment) => code(haystack).split('\n').some((l) => squash(l).trim() === squash(fragment));

  // Counting: foundations by the hosting switch, the task definition and service also by the image.
  const resources = [...text.matchAll(/^resource "([^"]+)" "([^"]+)"/gm)];
  need(resources.length >= 20, 'the scan must find the resources (a floor, so an empty read cannot pass)');
  const SERVICE_ONLY = new Set(['aws_ecs_task_definition.worker', 'aws_ecs_service.worker']);
  for (const [header, type, name] of resources) {
    const b = blocks(text, header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))[0] ?? '';
    const want = SERVICE_ONLY.has(`${type}.${name}`) ? 'local.api_service_count' : 'local.api_count';
    need(has(b, `count = ${want}`), `${type}.${name} must be counted by ${want}`);
  }

  // The secret: a container, encrypted, no value.
  need(!/aws_secretsmanager_secret_version|secret_string|secret_binary/.test(text), 'no secret value may be in Terraform');
  const secret = one('resource "aws_secretsmanager_secret" "worker_database_url"');
  need(has(secret, 'kms_key_id = aws_kms_key.data.arn') && has(secret, 'recovery_window_in_days = local.secret_recovery_days'), 'the worker secret must use the data key and the profile recovery window');

  // The worker's task role: read-only on report files, nothing else.
  const taskRole = one('resource "aws_iam_role" "worker_task"');
  need(has(taskRole, 'assume_role_policy = data.aws_iam_policy_document.api_ecs_assume.json'), 'the worker task role must use the account-and-source-limited ECS trust');
  need(has(text, 'policy_arn = aws_iam_policy.worker_runtime.arn') && !/aws_iam_role_policy" "worker_task"/.test(text), 'the worker task role must get only the worker_runtime policy');
  const runtime = one('data "aws_iam_policy_document" "worker_runtime"', code(iamTf));
  const runtimeStatements = statements(runtime);
  need(runtimeStatements.length === 2, 'the worker runtime policy must have exactly two statements (read the files, decrypt them)');
  const read_ = runtimeStatements.find((s) => s.sid === 'ReadReportFileVersions');
  need(read_ !== undefined && read_.actions.replace(/\s/g, '') === '["s3:GetObject","s3:GetObjectVersion"]', 'the worker may only get objects and object versions');
  need(read_ !== undefined && read_.resources.trim() === '["${aws_s3_bucket.reports.arn}/reports/*"]', 'the worker may read only the report files');
  const decrypt = runtimeStatements.find((s) => s.sid === 'DecryptReportFiles');
  need(decrypt !== undefined && decrypt.actions.replace(/\s/g, '') === '["kms:Decrypt"]' && has(decrypt.body, 'variable = "kms:ViaService"') && has(decrypt.body, 'values   = ["s3.${var.region}.amazonaws.com"]'), 'the worker may decrypt only through S3');
  need(!/s3:(Put|Delete|List|Abort|Restore|Replicate)|s3:\*|kms:(Generate|Encrypt|ReEncrypt|\*)|secretsmanager|"iam:|sqs:|ecs:|resources\s*=\s*\["\*"\]/.test(runtime), 'the worker runtime policy must hold no write, list, key-creation, secrets, iam or wildcard right');

  // The execution role: pulls this image, writes its own logs, reads only its own secret.
  const exec = one('data "aws_iam_policy_document" "worker_execution"');
  const execStatements = statements(exec);
  const secretRead = execStatements.find((s) => s.actions.includes('secretsmanager:GetSecretValue'));
  need(secretRead !== undefined && secretRead.resources.trim() === '[aws_secretsmanager_secret.worker_database_url[0].arn]', 'the worker execution role must read the worker secret and no other');
  need(!/api_database_url|api_migrator_url|api_ledger_verifier_url|api_invitation_digest_key|api_identifier_digest_key|master_user_secret/.test(code(exec)), 'the worker execution role must not reach any other secret');
  const pull = execStatements.find((s) => s.actions.includes('ecr:BatchGetImage'));
  need(pull !== undefined && pull.resources.trim() === '[local.api_repository]', 'the worker may pull only this repository');
  const logs = execStatements.find((s) => s.actions.includes('logs:PutLogEvents'));
  need(logs !== undefined && logs.resources.includes('log-group:${local.worker_log_group}:*'), 'the worker may write only its own log group');
  const kms = execStatements.find((s) => s.actions.includes('kms:Decrypt'));
  need(kms !== undefined && has(kms.body, 'variable = "kms:ViaService"') && has(kms.body, 'secretsmanager.${var.region}.amazonaws.com'), 'the worker execution role may use the data key only through Secrets Manager');
  need(!/AmazonECSTaskExecutionRolePolicy|"secretsmanager:\*"|resources\s*=\s*\["\*"\]/.test(code(exec).replace(/actions\s*=\s*\["ecr:GetAuthorizationToken"\]\s*\n\s*resources\s*=\s*\["\*"\]/, '')), 'no broad managed policy and no wildcard (except the ECR login, which has no resource)');

  // Network: nothing comes in; out only to the database and HTTPS.
  const sg = one('resource "aws_security_group" "worker_tasks"');
  need(!/\bingress\b/.test(code(sg)), 'the worker tasks must accept no connection');
  need(!/aws_vpc_security_group_ingress_rule" "worker_tasks/.test(text), 'the worker tasks must have no ingress rule');
  need(has(one('resource "aws_vpc_security_group_egress_rule" "worker_tasks_to_database"'), 'referenced_security_group_id = aws_security_group.db.id') && has(one('resource "aws_vpc_security_group_egress_rule" "worker_tasks_to_database"'), 'to_port = 5432'), 'the worker may reach the database on 5432');
  const https = one('resource "aws_vpc_security_group_egress_rule" "worker_tasks_https_out"');
  need(has(https, 'from_port = 443') && has(https, 'to_port = 443'), 'the only other way out is HTTPS');
  const dbIn = one('resource "aws_vpc_security_group_ingress_rule" "worker_db_from_tasks"');
  need(has(dbIn, 'security_group_id = aws_security_group.db.id') && has(dbIn, 'referenced_security_group_id = aws_security_group.worker_tasks[0].id') && has(dbIn, 'to_port = 5432'), 'the database admits the worker tasks on 5432 only');

  // The task and the service.
  const task = one('resource "aws_ecs_task_definition" "worker"');
  need(has(task, 'task_role_arn = aws_iam_role.worker_task[0].arn') && has(task, 'execution_role_arn = aws_iam_role.worker_execution[0].arn'), 'the worker must use its own two roles');
  need(has(task, 'network_mode = "awsvpc"') && has(task, 'requires_compatibilities = ["FARGATE"]'), 'the worker must be Fargate with awsvpc networking');
  need(has(task, 'image = var.api_image') && has(task, 'command = ["worker/main.js"]'), 'the worker must run the pinned image, started as the worker bundle');
  need(has(task, 'readonlyRootFilesystem = true') && has(task, 'user = local.api_user'), 'the worker must have a read-only filesystem and run as the non-root user');
  // The worker writes no files (apps/worker/src/boundaries.test.ts), so it gets no volume and no mount: a writable path would be unused attack surface and would hide a fault.
  need(!/\bvolume\s*\{/.test(code(task)) && !/\bmountPoints\b/.test(code(task)), 'the worker task must declare no volume and mount nothing (it writes no files)');
  need(!/privileged|linuxParameters|"0"/.test(code(task)), 'the worker must hold no privileged mode, extra Linux parameters or root user');
  need(has(task, 'stopTimeout = 60'), 'the worker must be given time to drain (longer than WORKER_DRAIN_SECONDS)');
  need(has(task, 'secrets = [{ name = "DATABASE_URL", valueFrom = aws_secretsmanager_secret.worker_database_url[0].arn }]'), 'the worker login must be injected as DATABASE_URL from the worker secret, and be the only secret');
  need(has(task, 'logConfiguration') && has(task, '"awslogs-group" = aws_cloudwatch_log_group.worker[0].name'), 'the worker must log to its own group');
  need(has(task, 'healthCheck') && has(task, '/livez'), 'the worker must be checked on /livez (by the container itself)');
  need(!/portMappings/.test(code(task)), 'the worker publishes no port');
  const service = one('resource "aws_ecs_service" "worker"');
  need(!/load_balancer/.test(code(service)) && !/aws_lb\b/.test(code(service)), 'no load balancer may reach the worker');
  need(has(service, 'enable_execute_command = false'), 'no shell may be opened into a worker task');
  need(has(service, 'launch_type = "FARGATE"') && has(service, 'desired_count = var.worker_desired_count') && has(service, 'cluster = aws_ecs_cluster.api[0].id'), 'the worker must be Fargate on the API cluster with its own desired count');
  need(has(service, 'security_groups = [aws_security_group.worker_tasks[0].id]') && has(service, 'subnets = local.data_subnet_ids') && has(service, 'assign_public_ip = local.tasks_public_ip') && !/assign_public_ip\s*=\s*true/.test(code(service)), 'the worker must sit in its own security group in the data subnets, with a public address only through the synthetic profile');
  need(has(service, 'enable = true') && has(service, 'rollback = true') && has(service, 'deployment_minimum_healthy_percent = 100'), 'a failed deployment must roll back and never reduce healthy capacity');

  // The environment: what production start-up demands, and no secret and no test setting.
  const env = blocks(text, 'worker_environment = ')[0] ?? '';
  const keys = [...env.matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*=/gm)].map((m) => m[1]);
  for (const key of ['NODE_ENV', 'DATABASE_SSL', 'REPORTS_BUCKET', 'AWS_REGION']) need(keys.includes(key), `the worker environment must set ${key}`);
  for (const key of ['DATABASE_URL', 'DATABASE_MIGRATOR_URL', 'DATABASE_ADMIN_URL', 'LEDGER_VERIFIER_DATABASE_URL', 'INVITATION_DIGEST_KEY', 'IDENTIFIER_DIGEST_KEY', 'WORKER_TEST_JOBS', 'WORKER_TEST_EFFECT_DIR', 'S3_ENDPOINT', 'WORKER_ID']) need(!keys.includes(key), `${key} must not be a plain worker environment value`);
  need(has(env, 'NODE_ENV = "production"') && has(env, 'DATABASE_SSL = "require"') && has(env, 'WORKER_HEALTH_HOST = "127.0.0.1"'), 'the worker must run as production with TLS to the database and a loopback health port');
  need(has(env, 'REPORTS_BUCKET = aws_s3_bucket.reports.bucket'), 'the worker must read the reports bucket');
  need(has(text, 'worker_health = 8081') && has(env, 'WORKER_HEALTH_PORT = tostring(local.worker_health)'), 'the health port must be one value');

  // The log group and its key.
  const key = one('data "aws_iam_policy_document" "worker_logs_key"');
  need(!/identifiers\s*=\s*\["\*"\]/.test(key) && has(key, 'log-group:${local.worker_log_group}"'), 'the log key may be used by the log service for the worker log group only');
  need(has(one('resource "aws_kms_key" "worker_logs"'), 'enable_key_rotation = true'), 'the worker log key must rotate');
  const group = one('resource "aws_cloudwatch_log_group" "worker"');
  need(has(group, 'kms_key_id = aws_kms_key.worker_logs[0].arn') && has(group, 'retention_in_days = var.api_log_retention_days') && has(group, 'name = local.worker_log_group'), 'the worker log group must be encrypted with its own key and use the retention variable');

  // The alarms: each pattern matches a literal the worker writes.
  const pattern = (name) => /pattern\s*=\s*"(.*)"\s*$/m.exec(one(`resource "aws_cloudwatch_log_metric_filter" "${name}"`))?.[1].replace(/\\"/g, '"') ?? '';
  const dead = pattern('worker_job_dead');
  need(dead === '{ $.event = "job-finished" && $.outcome = "dead" }', 'the dead-job filter must match job-finished with outcome dead, at the top level');
  need(/'job-finished'/.test(runner) && /state === 'dead'/.test(runner), 'the runner must still log job-finished with the state as the outcome');
  const failed = pattern('worker_file_check_failed');
  need(failed.includes('$.event = "file-verified"') && failed.includes('$.outcome != "ok"') && failed.includes('$.event = "files-reverified"') && failed.includes('$.running > 0'), 'the file-check filter must match a failed single check and a failed re-check run');
  need(/'file-verified'/.test(filesVerify) && /'files-reverified'/.test(filesVerify) && /outcome: verdict\.outcome/.test(filesVerify) && /running: bad\.length/.test(filesVerify), 'the file handlers must still log the fields the file-check filter reads');
  need(pattern('worker_queue_age') === '{ $.event = "queue-stats" }' && pattern('worker_heartbeat') === '{ $.event = "queue-stats" }', 'the queue filters must match the queue-stats event');
  need(/'queue-stats'/.test(main) && /ageSeconds:/.test(main), 'the worker must still log queue-stats with ageSeconds');
  need(has(one('resource "aws_cloudwatch_log_metric_filter" "worker_queue_age"'), 'value = "$.ageSeconds"'), 'the queue-age metric must be the logged age');
  const drain = one('resource "aws_cloudwatch_metric_alarm" "worker_queue_not_draining"');
  need(has(drain, 'metric_name = "QueueAgeSeconds"') && line(drain, 'threshold = 900') && has(drain, 'comparison_operator = "GreaterThanThreshold"') && line(drain, 'evaluation_periods = 2'), 'a ready job waiting more than 15 minutes, twice running, must raise the queue alarm');
  const beat = one('resource "aws_cloudwatch_metric_alarm" "worker_heartbeat_stale"');
  need(has(beat, 'metric_name = "WorkerHeartbeats"') && has(beat, 'comparison_operator = "LessThanThreshold"') && line(beat, 'threshold = 1') && has(beat, 'treat_missing_data = "breaching"') && has(beat, 'statistic = "Sum"'), 'no worker report for five minutes (or no data at all) must raise the heartbeat alarm');
  for (const alarm of ['worker_job_dead', 'worker_file_check_failed', 'worker_queue_not_draining', 'worker_heartbeat_stale']) {
    const b = one(`resource "aws_cloudwatch_metric_alarm" "${alarm}"`);
    need(has(b, 'alarm_actions = [aws_sns_topic.audit_alarms.arn]'), `the ${alarm} alarm must notify the audit topic`);
    need(has(b, 'namespace = local.worker_metrics'), `the ${alarm} alarm must read the worker metrics namespace`);
  }
  for (const alarm of ['worker_job_dead', 'worker_file_check_failed']) need(has(one(`resource "aws_cloudwatch_metric_alarm" "${alarm}"`), 'treat_missing_data = "notBreaching"'), `silence is normal for ${alarm}`);
  for (const name of ['worker_secret_arn', 'worker_service_name']) need(has(text, `output "${name}"`), `output ${name} is missing`);
  return problems;
}

test('the worker compute text has no problems (and the scan found the files: a floor, so an empty read cannot pass)', () => {
  assert.ok(worker.length > 10000 && worker.includes('resource "aws_ecs_service" "worker"'));
  assert.ok(iam.includes('data "aws_iam_policy_document" "worker_runtime"'));
  assert.deepEqual(workerProblems(worker), []);
});

test('the worker compute guard reports each way the text could be weakened (controls)', () => {
  const weakened = [
    ['the secret container not counted', 'resource "aws_secretsmanager_secret" "worker_database_url" {\n  count       = local.api_count\n', 'resource "aws_secretsmanager_secret" "worker_database_url" {\n'],
    ['the service counted by the wrong switch', 'resource "aws_ecs_service" "worker" {\n  count                              = local.api_service_count', 'resource "aws_ecs_service" "worker" {\n  count                              = local.api_count'],
    ['a secret value in Terraform', 'resource "aws_secretsmanager_secret" "worker_database_url" {', 'resource "aws_secretsmanager_secret_version" "oops" {\n  count         = local.api_count\n  secret_id     = "x"\n  secret_string = "postgres://x"\n}\n\nresource "aws_secretsmanager_secret" "worker_database_url" {'],
    ['the secret not encrypted with the data key', 'Written by provision-logins."\n  kms_key_id  = aws_kms_key.data.arn', 'Written by provision-logins."\n  kms_key_id  = "alias/aws/secretsmanager"'],
    ['the task role gets its own policy', 'resource "aws_iam_role_policy_attachment" "worker_task_runtime" {', 'resource "aws_iam_role_policy" "worker_task" {\n  count  = local.api_count\n  name   = "x"\n  role   = aws_iam_role.worker_task[0].id\n  policy = "{}"\n}\n\nresource "aws_iam_role_policy_attachment" "worker_task_runtime" {'],
    ['the task role gets the application policy', 'policy_arn = aws_iam_policy.worker_runtime.arn', 'policy_arn = aws_iam_policy.app_runtime.arn'],
    ['the execution role reads the application secret', 'resources = [aws_secretsmanager_secret.worker_database_url[0].arn]\n  }\n  statement {\n    sid       = "DecryptSecretsThroughSecretsManager"', 'resources = [aws_secretsmanager_secret.worker_database_url[0].arn, aws_secretsmanager_secret.api_database_url[0].arn]\n  }\n  statement {\n    sid       = "DecryptSecretsThroughSecretsManager"'],
    ['the execution role reads the migrator secret instead', 'resources = [aws_secretsmanager_secret.worker_database_url[0].arn]\n  }\n  statement {\n    sid       = "DecryptSecretsThroughSecretsManager"', 'resources = [aws_secretsmanager_secret.api_migrator_url[0].arn]\n  }\n  statement {\n    sid       = "DecryptSecretsThroughSecretsManager"'],
    ['pulls from any repository', 'resources = [local.api_repository]', 'resources = ["*"]'],
    ['logs written anywhere', 'resources = ["arn:aws:logs:${var.region}:${local.audit_account_id}:log-group:${local.worker_log_group}:*"]', 'resources = ["*"]'],
    ['secrets decrypted outside Secrets Manager', 'values   = ["secretsmanager.${var.region}.amazonaws.com"]\n    }\n  }\n}\n\nresource "aws_iam_role" "worker_execution"', 'values   = ["s3.${var.region}.amazonaws.com"]\n    }\n  }\n}\n\nresource "aws_iam_role" "worker_execution"'],
    ['a connection is admitted to the tasks', 'resource "aws_vpc_security_group_egress_rule" "worker_tasks_to_database" {', 'resource "aws_vpc_security_group_ingress_rule" "worker_tasks_in" {\n  count             = local.api_count\n  security_group_id = aws_security_group.worker_tasks[0].id\n  cidr_ipv4         = "0.0.0.0/0"\n  ip_protocol       = "tcp"\n  from_port         = 8081\n  to_port           = 8081\n}\n\nresource "aws_vpc_security_group_egress_rule" "worker_tasks_to_database" {'],
    ['the database admits the wrong group', 'referenced_security_group_id = aws_security_group.worker_tasks[0].id\n  ip_protocol', 'referenced_security_group_id = aws_security_group.api_tasks[0].id\n  ip_protocol'],
    ['the https egress widened', 'from_port         = 443\n  to_port           = 443\n  description       = "HTTPS to AWS', 'from_port         = 0\n  to_port           = 443\n  description       = "HTTPS to AWS'],
    ['the worker uses the API roles', 'task_role_arn            = aws_iam_role.worker_task[0].arn', 'task_role_arn            = aws_iam_role.api_task[0].arn'],
    ['root filesystem writable', 'readonlyRootFilesystem = true\n      command', 'readonlyRootFilesystem = false\n      command'],
    ['container runs as root', 'user                   = local.api_user\n      readonlyRootFilesystem = true\n      command', 'user                   = "0"\n      readonlyRootFilesystem = true\n      command'],
    ['the worker started as the API', 'command                = ["worker/main.js"]', 'command                = ["dist/main.js"]'],
    ['stop timeout dropped', 'stopTimeout            = 60', 'stopTimeout            = 2'],
    ['an ephemeral volume is declared', '  runtime_platform {\n    operating_system_family = "LINUX"', '  volume {\n    name = "scratch"\n  }\n\n  runtime_platform {\n    operating_system_family = "LINUX"'],
    ['a host path is bound as a volume', '  runtime_platform {\n    operating_system_family = "LINUX"', '  volume {\n    name      = "host"\n    host_path = "/var"\n  }\n\n  runtime_platform {\n    operating_system_family = "LINUX"'],
    ['a writable mount at /tmp', 'readonlyRootFilesystem = true\n      command', 'readonlyRootFilesystem = true\n      mountPoints            = [{ sourceVolume = "scratch", containerPath = "/tmp", readOnly = false }]\n      command'],
    ['image is a free variable', 'image                  = var.api_image\n      essential              = true\n      user                   = local.api_user\n      readonlyRootFilesystem = true\n      command', 'image                  = "x:latest"\n      essential              = true\n      user                   = local.api_user\n      readonlyRootFilesystem = true\n      command'],
    ['the worker holds the migrator login', 'secrets                = [{ name = "DATABASE_URL", valueFrom = aws_secretsmanager_secret.worker_database_url[0].arn }]', 'secrets                = [{ name = "DATABASE_URL", valueFrom = aws_secretsmanager_secret.worker_database_url[0].arn }, { name = "DATABASE_MIGRATOR_URL", valueFrom = aws_secretsmanager_secret.api_migrator_url[0].arn }]'],
    ['the worker login not injected', 'secrets                = [{ name = "DATABASE_URL", valueFrom = aws_secretsmanager_secret.worker_database_url[0].arn }]', 'secrets                = []'],
    ['a port is published', 'readonlyRootFilesystem = true\n      command', 'readonlyRootFilesystem = true\n      portMappings           = [{ containerPort = 8081 }]\n      command'],
    ['the health check removed', '/livez', '/x'],
    ['a shell can be opened', 'enable_execute_command             = false', 'enable_execute_command             = true'],
    ['a load balancer reaches the worker', 'deployment_circuit_breaker {', 'load_balancer {\n    target_group_arn = aws_lb_target_group.api[0].arn\n    container_name   = "worker"\n    container_port   = 8081\n  }\n\n  deployment_circuit_breaker {'],
    ['a public address always', 'assign_public_ip = local.tasks_public_ip\n  }\n}', 'assign_public_ip = true\n  }\n}'],
    ['the service in the API group', 'security_groups  = [aws_security_group.worker_tasks[0].id]', 'security_groups  = [aws_security_group.api_tasks[0].id]'],
    ['rollback dropped', 'rollback = true', 'rollback = false'],
    ['test jobs in the environment', '    WORKER_CONCURRENCY   = "4"', '    WORKER_TEST_JOBS     = "yes"\n    WORKER_CONCURRENCY   = "4"'],
    ['the login as plain environment', '    WORKER_CONCURRENCY   = "4"', '    DATABASE_URL         = "postgres://x"\n    WORKER_CONCURRENCY   = "4"'],
    ['no bucket', '    REPORTS_BUCKET       = aws_s3_bucket.reports.bucket\n', ''],
    ['database TLS off', 'DATABASE_SSL         = "require"', 'DATABASE_SSL         = "disable"'],
    ['health port open to the network', 'WORKER_HEALTH_HOST   = "127.0.0.1"', 'WORKER_HEALTH_HOST   = "0.0.0.0"'],
    ['log key for any group', 'values   = ["arn:aws:logs:${var.region}:${local.audit_account_id}:log-group:${local.worker_log_group}"]', 'values   = ["*"]'],
    ['log key does not rotate', 'description             = "${local.name} worker logs"\n  enable_key_rotation     = true', 'description             = "${local.name} worker logs"\n  enable_key_rotation     = false'],
    ['the dead-job pattern is nested', '{ $.event = \\"job-finished\\" && $.outcome = \\"dead\\" }', '{ $.log.event = \\"job-finished\\" && $.outcome = \\"dead\\" }'],
    ['the dead-job pattern misses dead', '$.outcome = \\"dead\\"', '$.outcome = \\"failed\\"'],
    ['the file-check pattern misses a run', ' || ($.event = \\"files-reverified\\" && $.running > 0)', ''],
    ['the queue pattern misses the event', 'pattern        = "{ $.event = \\"queue-stats\\" }"\n  metric_transformation {\n    name      = "QueueAgeSeconds"', 'pattern        = "{ $.event = \\"queue-stat\\" }"\n  metric_transformation {\n    name      = "QueueAgeSeconds"'],
    ['the queue metric is a count', 'value     = "$.ageSeconds"', 'value     = "1"'],
    ['the queue alarm threshold raised', 'threshold           = 900', 'threshold           = 90000'],
    ['the queue alarm needs one check only', 'evaluation_periods  = 2', 'evaluation_periods  = 1'],
    ['silence is fine for the heartbeat', 'comparison_operator = "LessThanThreshold"\n  treat_missing_data  = "breaching"', 'comparison_operator = "LessThanThreshold"\n  treat_missing_data  = "notBreaching"'],
    ['an alarm tells nobody', 'resource "aws_cloudwatch_metric_alarm" "worker_job_dead" {\n  count               = local.api_count\n  alarm_name          = "${local.name}-worker-job-dead"\n  alarm_description   = "A background job ended dead and waits for a person: run `jobs dead` (docs/ops/jobs.md)."\n  namespace           = local.worker_metrics\n  metric_name         = "JobsDead"\n  statistic           = "Sum"\n  period              = 300\n  evaluation_periods  = 1\n  threshold           = 1\n  comparison_operator = "GreaterThanOrEqualToThreshold"\n  treat_missing_data  = "notBreaching"\n  alarm_actions       = [aws_sns_topic.audit_alarms.arn]', 'resource "aws_cloudwatch_metric_alarm" "worker_job_dead" {\n  count               = local.api_count\n  alarm_name          = "${local.name}-worker-job-dead"\n  alarm_description   = "A background job ended dead and waits for a person: run `jobs dead` (docs/ops/jobs.md)."\n  namespace           = local.worker_metrics\n  metric_name         = "JobsDead"\n  statistic           = "Sum"\n  period              = 300\n  evaluation_periods  = 1\n  threshold           = 1\n  comparison_operator = "GreaterThanOrEqualToThreshold"\n  treat_missing_data  = "notBreaching"\n  alarm_actions       = []'],
    ['an output missing', 'output "worker_service_name"', 'output "worker_service"'],
  ];
  for (const [name, from, to] of weakened) {
    assert.ok(worker.includes(from), `the control for "${name}" must match the real text (it does not: fix the control)`);
    assert.ok(workerProblems(worker.replace(from, to)).length > 0, `a weakened text must be reported: ${name}`);
  }
  // The read-only policy lives in iam.tf.
  const weakenedPolicy = [
    ['the worker may write report files', 'actions   = ["s3:GetObject", "s3:GetObjectVersion"]\n    resources = ["${aws_s3_bucket.reports.arn}/reports/*"]', 'actions   = ["s3:GetObject", "s3:GetObjectVersion", "s3:PutObject"]\n    resources = ["${aws_s3_bucket.reports.arn}/reports/*"]'],
    ['the worker may read the whole bucket', 'resources = ["${aws_s3_bucket.reports.arn}/reports/*"]\n  }\n  statement {\n    sid       = "DecryptReportFiles"', 'resources = ["${aws_s3_bucket.reports.arn}/*"]\n  }\n  statement {\n    sid       = "DecryptReportFiles"'],
    ['the worker may list the bucket', 'actions   = ["s3:GetObject", "s3:GetObjectVersion"]\n    resources = ["${aws_s3_bucket.reports.arn}/reports/*"]', 'actions   = ["s3:GetObject", "s3:GetObjectVersion", "s3:ListBucket"]\n    resources = ["${aws_s3_bucket.reports.arn}/reports/*"]'],
    ['the worker may decrypt anywhere', 'values   = ["s3.${var.region}.amazonaws.com"]\n    }\n  }\n}\n\nresource "aws_iam_policy" "worker_runtime"', 'values   = ["rds.${var.region}.amazonaws.com"]\n    }\n  }\n}\n\nresource "aws_iam_policy" "worker_runtime"'],
    ['the worker may create data keys', 'actions   = ["kms:Decrypt"]\n    resources = [aws_kms_key.data.arn]\n    condition {\n      test     = "StringEquals"\n      variable = "kms:ViaService"\n      values   = ["s3.${var.region}.amazonaws.com"]\n    }\n  }\n}\n\nresource "aws_iam_policy" "worker_runtime"', 'actions   = ["kms:Decrypt", "kms:GenerateDataKey"]\n    resources = [aws_kms_key.data.arn]\n    condition {\n      test     = "StringEquals"\n      variable = "kms:ViaService"\n      values   = ["s3.${var.region}.amazonaws.com"]\n    }\n  }\n}\n\nresource "aws_iam_policy" "worker_runtime"'],
  ];
  for (const [name, from, to] of weakenedPolicy) {
    assert.ok(iam.includes(from), `the control for "${name}" must match the real text (it does not: fix the control)`);
    assert.ok(workerProblems(worker, iam.replace(from, to)).length > 0, `a weakened policy must be reported: ${name}`);
  }
  // The worker side of the alarm contract.
  const workerSide = [
    ['the runner stops logging job-finished', { runner: runnerSource.replaceAll("'job-finished'", "'job-done'") }],
    ['the file handlers stop logging the check', { filesVerify: filesVerifySource.replaceAll("'file-verified'", "'file-checked'") }],
    ['the file handlers stop logging the run', { filesVerify: filesVerifySource.replace('running: bad.length', 'bad: bad.length') }],
    ['the worker stops logging queue-stats', { main: mainSource.replaceAll("'queue-stats'", "'queue'") }],
    ['the worker stops logging the age', { main: mainSource.replace('ageSeconds:', 'age:') }],
  ];
  for (const [name, sources] of workerSide) assert.ok(workerProblems(worker, iam, sources).length > 0, `a changed worker must be reported: ${name}`);
  assert.deepEqual(workerProblems(worker), []); // control: the unchanged text is clean
});
