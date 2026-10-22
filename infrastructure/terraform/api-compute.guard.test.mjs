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
const issuerTf = read('./issuer.tf');
const ledgerSource = read('../../apps/backend/src/ledger/ledger-monitor.ts');
const logShapeSpec = read('../../apps/backend/src/log-shape.spec.ts');
const loggerOptions = read('../../apps/backend/src/logger-options.ts');
const appModule = read('../../apps/backend/src/app.module.ts');
const cliSource = read('../../apps/backend/src/db/cli.ts');
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
  DATABASE_URL: 'postgres://app_login@db.example:5432/telesphoros',
  LEDGER_VERIFIER_DATABASE_URL: 'postgres://verifier_login@db.example:5432/telesphoros',
  INVITATION_DIGEST_KEY: 'ab'.repeat(32),
  IDENTIFIER_DIGEST_KEY: 'cd'.repeat(32),
  TLS_CERT_PEM: 'synthetic-cert-pem',
  TLS_KEY_PEM: 'synthetic-key-pem',
};
/** Values that must never be plain environment: secrets, and anything the production start-up refuses. */
const FORBIDDEN_ENVIRONMENT = ['DATABASE_URL', 'LEDGER_VERIFIER_DATABASE_URL', 'INVITATION_DIGEST_KEY', 'IDENTIFIER_DIGEST_KEY', 'DATABASE_MIGRATOR_URL', 'DATABASE_ADMIN_URL', 'JWT_SECRET', 'LAB_REPORT_PIPELINE', 'COGNITO_ISSUER', 'COGNITO_JWKS_URI', 'S3_ENDPOINT', 'KNOWLEDGE_DIR', 'LAB_REPORT_FIXTURES_DIR', 'LAB_REPORT_PIPELINE'];

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
  const cli = sources.cli ?? cliSource;
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
  const SERVICE_ONLY = new Set(['aws_ecs_task_definition.api', 'aws_ecs_task_definition.api_migrate', 'aws_ecs_task_definition.api_provision', 'aws_ecs_service.api', 'aws_cloudwatch_metric_alarm.api_unhealthy_targets', 'aws_cloudwatch_metric_alarm.api_target_5xx', 'aws_cloudwatch_metric_alarm.api_running_tasks']);
  for (const [header, type, name] of resources) {
    const b = blocks(text, header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))[0] ?? '';
    const want = SERVICE_ONLY.has(`${type}.${name}`) ? 'local.api_service_count' : 'local.api_count';
    need(has(b, `count = ${want}`), `${type}.${name} must be counted by ${want}`);
  }

  // Secrets: containers only, encrypted, no value anywhere.
  need(!/aws_secretsmanager_secret_version|secret_string|secret_binary/.test(text), 'no secret value may be in Terraform (no secret version, no secret string)');
  for (const name of ['api_database_url', 'api_ledger_verifier_url', 'api_invitation_digest_key', 'api_identifier_digest_key', 'api_tls_cert', 'api_tls_key', 'api_migrator_url']) need(has(one(`resource "aws_secretsmanager_secret" "${name}"`), 'kms_key_id = aws_kms_key.data.arn'), `the ${name} secret must be encrypted with the data key`);

  // Roles.
  need(!text.includes('AmazonECSTaskExecutionRolePolicy'), 'the broad managed execution policy must not be used');
  need(!/aws_iam_role_policy" "api_task"/.test(text) && !/iam:PassRole/.test(text), 'the task role must carry the app_runtime policy and nothing of its own');
  need(has(one('resource "aws_iam_role_policy_attachment" "api_task_runtime"'), 'policy_arn = aws_iam_policy.app_runtime.arn') && has(one('resource "aws_iam_role_policy_attachment" "api_task_runtime"'), 'role = aws_iam_role.api_task[0].name'), 'the task role must have the app_runtime policy attached');
  const assume = one('data "aws_iam_policy_document" "api_ecs_assume"');
  need(has(assume, 'identifiers = ["ecs-tasks.amazonaws.com"]') && has(assume, 'variable = "aws:SourceAccount"'), 'the roles must be assumable by ECS tasks of this account only');
  for (const role of ['api_task', 'api_execution_service', 'api_execution_migrate', 'api_execution_provision', 'api_provision_task']) need(has(one(`resource "aws_iam_role" "${role}"`), 'assume_role_policy = data.aws_iam_policy_document.api_ecs_assume.json'), `the ${role} role must use the ECS-only trust`);
  for (const [doc, secrets, other] of [
    ['api_execution_service', ['api_database_url[0].arn', 'api_ledger_verifier_url[0].arn', 'api_invitation_digest_key[0].arn', 'api_identifier_digest_key[0].arn', 'api_tls_cert[0].arn', 'api_tls_key[0].arn'], 'api_migrator_url'],
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
  // They index secrets that exist only when hosting is on, so they must be counted too: uncounted, the default variables cannot even be planned (FD-3).
  for (const doc of ['api_execution_service', 'api_execution_migrate']) need(has(one(`data "aws_iam_policy_document" "${doc}"`), 'count = local.api_count'), `${doc} must be counted by local.api_count`);

  // The service task definition.
  const task = one('resource "aws_ecs_task_definition" "api"');
  need(has(task, 'network_mode = "awsvpc"') && has(task, 'requires_compatibilities = ["FARGATE"]'), 'the task must be Fargate with awsvpc networking');
  need(has(task, 'task_role_arn = aws_iam_role.api_task[0].arn') && has(task, 'execution_role_arn = aws_iam_role.api_execution_service[0].arn'), 'the task must use the task role and the service execution role');
  need(has(task, 'image = var.api_image'), 'the task must run the digest-pinned image variable');
  need(has(task, 'readonlyRootFilesystem = true'), 'the root filesystem must be read-only');
  need(/volume \{\s*name = "scratch"\s*\}/.test(task), 'the scratch volume must be ephemeral: its block names nothing but the volume (no host path, no host block)');
  need(has(task, 'mountPoints = [{ sourceVolume = "scratch", containerPath = "/tmp", readOnly = false }]'), 'the only writable path must be /tmp, from that volume');
  need(has(task, 'user = local.api_user') && /api_user\s*=\s*"[1-9][0-9]+"/.test(text), 'the container must run as a non-root numeric user');
  need(has(task, 'stopTimeout = 30'), 'the stop timeout must give the application time to drain');
  need(has(task, 'environment = [for name, value in local.api_environment : { name = name, value = value }]'), 'the environment must come from local.api_environment');
  need(has(task, '"awslogs-group" = aws_cloudwatch_log_group.api[0].name') && has(task, 'logDriver = "awslogs"'), 'logs must go to the API log group');
  need(has(task, 'name = "DATABASE_URL", valueFrom = aws_secretsmanager_secret.api_database_url[0].arn') && has(task, 'name = "LEDGER_VERIFIER_DATABASE_URL", valueFrom = aws_secretsmanager_secret.api_ledger_verifier_url[0].arn'), 'the two database logins must be injected from their secrets');
  need(has(task, 'name = "INVITATION_DIGEST_KEY", valueFrom = aws_secretsmanager_secret.api_invitation_digest_key[0].arn'), 'the invitation digest key must be injected from its secret (production refuses to start without it)');
  need(has(task, 'name = "IDENTIFIER_DIGEST_KEY", valueFrom = aws_secretsmanager_secret.api_identifier_digest_key[0].arn'), 'the identifier digest key must be injected from its secret (production refuses to start without it)');
  need(has(task, 'name = "TLS_CERT_PEM", valueFrom = aws_secretsmanager_secret.api_tls_cert[0].arn') && has(task, 'name = "TLS_KEY_PEM", valueFrom = aws_secretsmanager_secret.api_tls_key[0].arn'), 'the API certificate and its key must be injected from their secrets (production refuses to start without them)');
  need(!has(task, 'DATABASE_MIGRATOR_URL'), 'the service must never hold the migrator login');
  need(has(task, 'condition = length(var.api_cors_origins) >= 1'), 'the task must require at least one CORS origin');

  // The one-off migration task.
  const migrate = one('resource "aws_ecs_task_definition" "api_migrate"');
  need(!has(migrate, 'task_role_arn'), 'the migration task must have no task role (it reaches the database only)');
  need(has(migrate, 'execution_role_arn = aws_iam_role.api_execution_migrate[0].arn'), 'the migration task must use its own execution role');
  need(has(migrate, 'command = ["dist/db/cli.js", "migrate", "up"]'), 'the migration task must run the migrate command');
  need(has(migrate, 'name = "DATABASE_MIGRATOR_URL", valueFrom = aws_secretsmanager_secret.api_migrator_url[0].arn'), 'the migration task must get the migrator login from its secret');
  need(has(migrate, 'readonlyRootFilesystem = true') && has(migrate, 'user = local.api_user'), 'the migration task must be read-only and non-root too');
  need(has(migrate, 'environment = [{ name = "DATABASE_SSL", value = "require" }]'), 'the migration task must set DATABASE_SSL=require: TLS comes only from that setting, never from the connection string');
  need(has(text, 'family = "${local.name}-api-migrate"') && !/aws_ecs_service" "api_migrate/.test(text), 'the migration task must be a task definition only, never a service');

  // The one-off provisioning task: creates the five logins (the issuer's only because PROVISION_SECRET_ISSUER names its secret). Its execution role injects the
  // administrator's credentials; its task role can touch ONLY the five connection-string secrets and can NOT read the administrator secret.
  const provision = one('resource "aws_ecs_task_definition" "api_provision"');
  need(has(provision, 'task_role_arn = aws_iam_role.api_provision_task[0].arn') && has(provision, 'execution_role_arn = aws_iam_role.api_execution_provision[0].arn'), 'the provisioning task must use its own two roles');
  need(has(provision, 'command = ["dist/db/cli.js", "provision-logins"]'), 'the provisioning task must run the provision-logins command');
  need(has(provision, 'readonlyRootFilesystem = true') && has(provision, 'user = local.api_user') && has(provision, 'image = var.api_image'), 'the provisioning task must be read-only, non-root and run the pinned image');
  need(has(provision, '{ name = "DATABASE_SSL", value = "require" }'), 'the provisioning task must set DATABASE_SSL=require');
  const SECRET_FOR_LOGIN = { APP: 'api_database_url', VERIFIER: 'api_ledger_verifier_url', MIGRATOR: 'api_migrator_url', WORKER: 'worker_database_url', ISSUER: 'issuer_database_url' };
  for (const [kind, secretName] of Object.entries(SECRET_FOR_LOGIN)) need(has(provision, `{ name = "PROVISION_SECRET_${kind}", value = aws_secretsmanager_secret.${secretName}[0].arn }`), `the provisioning task must name the ${kind.toLowerCase()} login secret (PROVISION_SECRET_${kind} = ${secretName})`);
  // Source tie: the names Terraform passes are exactly the names apps/backend/src/db/cli.ts reads (a renamed side leaves a login silently uncreated).
  const passedKinds = [...code(provision).matchAll(/name\s*=\s*"PROVISION_SECRET_([A-Z_]+)"/g)].map((m) => m[1]).sort();
  const readKinds = [...new Set([...code(cli).matchAll(/required\('PROVISION_SECRET_([A-Z_]+)'\)|process\.env\.PROVISION_SECRET_([A-Z_]+)/g)].map((m) => m[1] ?? m[2]))].sort();
  need(readKinds.length >= 4, 'the scan must find the PROVISION_SECRET names cli.ts reads (a floor, so an empty read cannot pass)');
  need(JSON.stringify(passedKinds) === JSON.stringify(readKinds), `the provisioning task must pass exactly the PROVISION_SECRET names cli.ts reads (Terraform: ${passedKinds.join(',')}; cli.ts: ${readKinds.join(',')})`);
  // The issuer secret is named in this file exactly twice: the provisioning task's environment and the provisioning task role. Never an execution role, the service or the API task role.
  need((text.match(/issuer_database_url/g) ?? []).length === 2, 'the issuer secret must be named exactly twice here (the provisioning environment and the provisioning task role)');
  need(has(provision, 'valueFrom = "${aws_db_instance.main.master_user_secret[0].secret_arn}:username::"') && has(provision, 'valueFrom = "${aws_db_instance.main.master_user_secret[0].secret_arn}:password::"'), "the administrator's credentials must be injected as the username and password keys of the RDS-managed secret, and nothing else of it");
  need(!/DATABASE_URL|DATABASE_MIGRATOR_URL|DATABASE_ADMIN_URL|LEDGER_VERIFIER/.test(code(provision)), 'the provisioning task must not be given any connection string');
  need(has(text, 'family = "${local.name}-api-provision"') && !/aws_ecs_service" "api_provision/.test(text), 'the provisioning task must be a task definition only, never a service');
  const provisionTask = one('data "aws_iam_policy_document" "api_provision_task"');
  const readWrite = statements(provisionTask).find((s) => s.actions.includes('secretsmanager:PutSecretValue'));
  need(readWrite !== undefined && readWrite.actions.replace(/\s/g, '') === '["secretsmanager:GetSecretValue","secretsmanager:PutSecretValue"]', 'the provisioning task role may only read and write secret values');
  for (const ref of ['api_database_url[0].arn', 'api_ledger_verifier_url[0].arn', 'api_migrator_url[0].arn', 'worker_database_url[0].arn', 'issuer_database_url[0].arn']) need(readWrite?.resources.includes(`aws_secretsmanager_secret.${ref}`), `the provisioning task role must reach ${ref}`);
  need(readWrite ? (readWrite.resources.match(/aws_secretsmanager_secret\./g) ?? []).length === 5 && !/["*]|\$\{|master_user_secret/.test(readWrite.resources) : false, 'the provisioning task role must reach exactly the five connection-string secrets, each named (no wildcard, no prefix, no interpolation)');
  need(!has(provisionTask, 'master_user_secret') && !/"secretsmanager:\*"|"iam:|"kms:\*"|resources\s*=\s*\["\*"\]/.test(code(provisionTask)), 'the provisioning task role must not read the administrator secret, hold iam or wildcard rights');
  const provisionDecrypt = statements(provisionTask).find((s) => s.actions.includes('kms:Decrypt'));
  need(provisionDecrypt !== undefined && has(provisionDecrypt.body, 'variable = "kms:ViaService"') && provisionDecrypt.resources.includes('aws_kms_key.data.arn'), 'the provisioning task role must use the data key only through Secrets Manager');
  const provisionExec = one('data "aws_iam_policy_document" "api_execution_provision"');
  const adminRead = statements(provisionExec).find((s) => s.actions.includes('secretsmanager:GetSecretValue'));
  need(adminRead !== undefined && adminRead.resources.trim() === '[aws_db_instance.main.master_user_secret[0].secret_arn]', 'the provisioning execution role must read the administrator secret and nothing else');
  need(has(provisionExec, 'source_policy_documents = [data.aws_iam_policy_document.api_execution_common.json]'), 'the provisioning execution role must build on the common statements');
  for (const doc of ['api_execution_provision', 'api_provision_task']) need(has(one(`data "aws_iam_policy_document" "${doc}"`), 'count = local.api_count'), `${doc} must be counted by local.api_count`);

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
  need(has(service, 'assign_public_ip = local.tasks_public_ip') && has(service, 'subnets = local.data_subnet_ids') && has(service, 'security_groups = [aws_security_group.api_tasks[0].id]'), 'tasks must run in the data subnets (private in production), with a public address only through the synthetic profile, in the tasks security group');
  need(!/assign_public_ip\s*=\s*true/.test(code(service)), 'no literal public address for the tasks');
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
  const migrateImage = one('variable "api_migrate_image"');
  need(has(migrateImage, 'default     = ""') && has(migrateImage, '@sha256:[0-9a-f]{64}$') && has(migrateImage, 'var.api_migrate_image == ""'), 'the migration image must default to empty (the service image) and be refused unless pinned by digest');
  need(has(one('resource "aws_ecs_task_definition" "api_migrate"'), 'image = var.api_migrate_image != "" ? var.api_migrate_image : var.api_image'), 'the migration task must run api_migrate_image when it is set, otherwise api_image (and only the migration task may)');
  need((text.match(/var\.api_migrate_image != ""/g) ?? []).length === 1, 'api_migrate_image must be used by the migration task alone: the service, worker and provisioning task keep api_image');
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

test("the address the API is given when the issuer is on is one the application's own loader accepts, and a broken one is refused (control)", () => {
  // Worked out from issuer.tf's own values, the way Terraform builds it, not typed here.
  const code2 = code(issuerTf);
  const dns = /^\s*issuer_dns_name\s*=\s*"([^"]+)"/m.exec(code2)?.[1];
  const port = /^\s*issuer_port\s*=\s*(\d+)/m.exec(code2)?.[1];
  assert.ok(dns && port, 'issuer.tf must name the issuer\'s dns name and port');
  const url = `http://${dns}:${port}`;
  const problems = [];
  const env = environmentOf(code(compute), problems);
  assert.deepEqual(problems, []);
  assert.equal('ISSUER_URL' in env, false, 'with the issuer off the API environment has no ISSUER_URL');
  assert.equal(loadEnv({ ...env, ...SECRET_PLACEHOLDERS, ISSUER_URL: url }).ISSUER_URL, url);
  assert.equal(loadEnv({ ...env, ...SECRET_PLACEHOLDERS }).ISSUER_URL, undefined);
  for (const broken of ['', `${dns}:${port}`, `http://user:pw@${dns}:${port}`, `${url}/v1`, `${url}?x=1`]) assert.throws(() => loadEnv({ ...env, ...SECRET_PLACEHOLDERS, ISSUER_URL: broken }), /ISSUER_URL/);
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
    ['the service reads the migrator secret', 'aws_secretsmanager_secret.api_identifier_digest_key[0].arn, aws_secretsmanager_secret.api_tls_cert[0].arn, aws_secretsmanager_secret.api_tls_key[0].arn]', 'aws_secretsmanager_secret.api_identifier_digest_key[0].arn, aws_secretsmanager_secret.api_tls_cert[0].arn, aws_secretsmanager_secret.api_tls_key[0].arn, aws_secretsmanager_secret.api_migrator_url[0].arn]'],
    ['the service cannot read the invitation key', 'aws_secretsmanager_secret.api_ledger_verifier_url[0].arn, aws_secretsmanager_secret.api_invitation_digest_key[0].arn, aws_secretsmanager_secret.api_identifier_digest_key[0].arn, aws_secretsmanager_secret.api_tls_cert[0].arn, aws_secretsmanager_secret.api_tls_key[0].arn]', 'aws_secretsmanager_secret.api_ledger_verifier_url[0].arn, aws_secretsmanager_secret.api_identifier_digest_key[0].arn, aws_secretsmanager_secret.api_tls_cert[0].arn, aws_secretsmanager_secret.api_tls_key[0].arn]'],
    ['the service cannot read the identifier key', 'aws_secretsmanager_secret.api_invitation_digest_key[0].arn, aws_secretsmanager_secret.api_identifier_digest_key[0].arn, aws_secretsmanager_secret.api_tls_cert[0].arn, aws_secretsmanager_secret.api_tls_key[0].arn]', 'aws_secretsmanager_secret.api_invitation_digest_key[0].arn, aws_secretsmanager_secret.api_tls_cert[0].arn, aws_secretsmanager_secret.api_tls_key[0].arn]'],
    ['the migration reads a runtime secret', 'resources = [aws_secretsmanager_secret.api_migrator_url[0].arn]', 'resources = [aws_secretsmanager_secret.api_migrator_url[0].arn, aws_secretsmanager_secret.api_database_url[0].arn]'],
    ['secrets decrypted outside Secrets Manager', 'values   = ["secretsmanager.${var.region}.amazonaws.com"]\n    }\n  }\n}\n\ndata "aws_iam_policy_document" "api_execution_migrate"', 'values   = ["s3.${var.region}.amazonaws.com"]\n    }\n  }\n}\n\ndata "aws_iam_policy_document" "api_execution_migrate"'],
    ['pulls from any repository', 'resources = [local.api_repository]', 'resources = ["*"]'],
    ['logs written anywhere', 'resources = ["arn:aws:logs:${var.region}:${local.audit_account_id}:log-group:${local.api_log_group}:*"]', 'resources = ["*"]'],
    ['task not on Fargate networking', 'network_mode             = "awsvpc"\n  cpu                      = var.api_cpu', 'network_mode             = "bridge"\n  cpu                      = var.api_cpu'],
    ['root filesystem writable', 'readonlyRootFilesystem = true\n      stopTimeout            = 30', 'readonlyRootFilesystem = false\n      stopTimeout            = 30'],
    ['scratch volume bound to a host path', 'volume {\n    name = "scratch"\n  }', 'volume {\n    name = "scratch"\n    host = {\n      source_path = "/data"\n    }\n  }'],
    ['scratch mount read-only', 'containerPath = "/tmp", readOnly = false }]', 'containerPath = "/tmp", readOnly = true }]'],
    ['scratch mounted over another path', 'containerPath = "/tmp", readOnly = false }]', 'containerPath = "/var/lib", readOnly = false }]'],
    ['container runs as root', 'api_user          = "10001"', 'api_user          = "0"'],
    ['stop timeout dropped', 'stopTimeout            = 30', 'stopTimeout            = 2'],
    ['image is a free variable', 'image                  = var.api_image\n      essential              = true\n      user                   = local.api_user\n      readonlyRootFilesystem = true\n      stopTimeout', 'image                  = "x:latest"\n      essential              = true\n      user                   = local.api_user\n      readonlyRootFilesystem = true\n      stopTimeout'],
    ['the service holds the migrator login', '{ name = "LEDGER_VERIFIER_DATABASE_URL", valueFrom = aws_secretsmanager_secret.api_ledger_verifier_url[0].arn },', '{ name = "LEDGER_VERIFIER_DATABASE_URL", valueFrom = aws_secretsmanager_secret.api_ledger_verifier_url[0].arn },\n        { name = "DATABASE_MIGRATOR_URL", valueFrom = aws_secretsmanager_secret.api_migrator_url[0].arn },'],
    ['the identifier key not injected', '        { name = "IDENTIFIER_DIGEST_KEY", valueFrom = aws_secretsmanager_secret.api_identifier_digest_key[0].arn },\n', ''],
    ['the identifier key put in plain environment', '  api_environment = merge({\n    NODE_ENV                          = "production"', '  api_environment = {\n    IDENTIFIER_DIGEST_KEY             = "0000"\n    NODE_ENV                          = "production"'],
    ['the digest key not injected', '        { name = "INVITATION_DIGEST_KEY", valueFrom = aws_secretsmanager_secret.api_invitation_digest_key[0].arn },\n', ''],
    ['the digest key put in plain environment', '  api_environment = merge({\n    NODE_ENV                          = "production"', '  api_environment = {\n    INVITATION_DIGEST_KEY             = "0000"\n    NODE_ENV                          = "production"'],
    ['the verifier login not injected', '{ name = "LEDGER_VERIFIER_DATABASE_URL", valueFrom = aws_secretsmanager_secret.api_ledger_verifier_url[0].arn },', ''],
    ['no CORS origin required', 'condition     = length(var.api_cors_origins) >= 1', 'condition     = true'],
    ['migration gets a task role', '# No task role: the migration reaches the database only, not S3 or anything else in the account.', 'task_role_arn = aws_iam_role.api_task[0].arn'],
    ['migration uses the service execution role', 'execution_role_arn       = aws_iam_role.api_execution_migrate[0].arn', 'execution_role_arn       = aws_iam_role.api_execution_service[0].arn'],
    ['migration task without TLS', 'environment = [{ name = "DATABASE_SSL", value = "require" }]', 'environment = [{ name = "DATABASE_SSL", value = "disable" }]'],
    ['migration command changed', 'command                = ["dist/db/cli.js", "migrate", "up"]', 'command                = ["dist/main.js"]'],
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
    ['tasks get a public address', 'assign_public_ip = local.tasks_public_ip', 'assign_public_ip = true'],
    ['tasks in the public subnets', 'subnets          = local.data_subnet_ids', 'subnets          = var.public_subnet_ids'],
    ['an execution policy not counted', 'data "aws_iam_policy_document" "api_execution_service" {\n  count                   = local.api_count\n', 'data "aws_iam_policy_document" "api_execution_service" {\n'],
    ['a migrator policy not counted', 'data "aws_iam_policy_document" "api_execution_migrate" {\n  count                   = local.api_count\n', 'data "aws_iam_policy_document" "api_execution_migrate" {\n'],
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
    ['migration image tag allowed', '@sha256:[0-9a-f]{64}$", var.api_migrate_image))', '", var.api_migrate_image))'],
    ['migration image has a default', 'type        = string\n  default     = ""\n  validation {\n    condition     = var.api_migrate_image == ""', 'type        = string\n  default     = "x"\n  validation {\n    condition     = var.api_migrate_image == ""'],
    ['migration task ignores its image variable', 'image                  = var.api_migrate_image != "" ? var.api_migrate_image : var.api_image', 'image                  = var.api_image'],
    ['service task takes the migration image', 'portMappings           = [{ containerPort = local.api_port, protocol = "tcp" }]\n', 'portMappings           = [{ containerPort = local.api_port, protocol = "tcp" }]\n      migrateImage           = var.api_migrate_image != "" ? 1 : 0\n'],
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
    ['provisioning task role can read the administrator secret', 'resources = [aws_secretsmanager_secret.api_database_url[0].arn, aws_secretsmanager_secret.api_ledger_verifier_url[0].arn, aws_secretsmanager_secret.api_migrator_url[0].arn, aws_secretsmanager_secret.worker_database_url[0].arn, aws_secretsmanager_secret.issuer_database_url[0].arn]', 'resources = [aws_secretsmanager_secret.api_database_url[0].arn, aws_secretsmanager_secret.api_ledger_verifier_url[0].arn, aws_secretsmanager_secret.api_migrator_url[0].arn, aws_secretsmanager_secret.worker_database_url[0].arn, aws_secretsmanager_secret.issuer_database_url[0].arn, aws_db_instance.main.master_user_secret[0].secret_arn]'],
    ['provisioning task role cannot write the worker secret', ', aws_secretsmanager_secret.worker_database_url[0].arn, aws_secretsmanager_secret.issuer_database_url[0].arn]\n  }\n  statement {\n    sid       = "UseTheDataKeyThroughSecretsManager"', ']\n  }\n  statement {\n    sid       = "UseTheDataKeyThroughSecretsManager"'],
    ['provisioning does not pass the worker secret', '        { name = "PROVISION_SECRET_WORKER", value = aws_secretsmanager_secret.worker_database_url[0].arn },\n', ''],
    ['provisioning task role may do anything with secrets', 'actions   = ["secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue"]', 'actions   = ["secretsmanager:*"]'],
    ['provisioning task role gains iam', 'sid       = "ReadAndWriteTheFiveConnectionStrings"', 'sid       = "ReadAndWriteTheFiveConnectionStrings"\n    # x\n    actions2  = ["iam:PassRole"]'],
    ['provisioning execution role reads more than the administrator secret', 'resources = [aws_db_instance.main.master_user_secret[0].secret_arn]', 'resources = [aws_db_instance.main.master_user_secret[0].secret_arn, aws_secretsmanager_secret.api_database_url[0].arn]'],
    ['provisioning runs the wrong command', 'command                = ["dist/db/cli.js", "provision-logins"]', 'command                = ["dist/db/cli.js", "migrate", "up"]'],
    ['provisioning gets the whole administrator secret', ':password::"', '"'],
    ['provisioning without TLS', '{ name = "DATABASE_SSL", value = "require" },\n        { name = "DATABASE_HOST"', '{ name = "DATABASE_SSL", value = "disable" },\n        { name = "DATABASE_HOST"'],
    ['provisioning task given a connection string', '{ name = "AWS_REGION", value = var.region },\n        { name = "PROVISION_SECRET_APP"', '{ name = "DATABASE_URL", value = "postgres://x" },\n        { name = "PROVISION_SECRET_APP"'],
    ['provisioning task writable filesystem', 'readonlyRootFilesystem = true\n      command                = ["dist/db/cli.js", "provision-logins"]', 'readonlyRootFilesystem = false\n      command                = ["dist/db/cli.js", "provision-logins"]'],
    // The issuer's login (PR C): the same controls as for the other four, for the fifth.
    ['provisioning task role cannot write the issuer secret', ', aws_secretsmanager_secret.worker_database_url[0].arn, aws_secretsmanager_secret.issuer_database_url[0].arn]\n  }', ', aws_secretsmanager_secret.worker_database_url[0].arn]\n  }'],
    ['provisioning does not pass the issuer secret', '        { name = "PROVISION_SECRET_ISSUER", value = aws_secretsmanager_secret.issuer_database_url[0].arn },\n', ''],
    ['provisioning passes the API secret as the issuer secret', 'name = "PROVISION_SECRET_ISSUER", value = aws_secretsmanager_secret.issuer_database_url[0].arn', 'name = "PROVISION_SECRET_ISSUER", value = aws_secretsmanager_secret.api_database_url[0].arn'],
    ['provisioning passes the issuer secret under a renamed variable', 'name = "PROVISION_SECRET_ISSUER"', 'name = "PROVISION_SECRET_SESSION_ISSUER"'],
    ['provisioning task role may use every secret (wildcard)', 'resources = [aws_secretsmanager_secret.api_database_url[0].arn, aws_secretsmanager_secret.api_ledger_verifier_url[0].arn, aws_secretsmanager_secret.api_migrator_url[0].arn, aws_secretsmanager_secret.worker_database_url[0].arn, aws_secretsmanager_secret.issuer_database_url[0].arn]', 'resources = ["*"]'],
    ['provisioning task role may use every secret under the project prefix', 'resources = [aws_secretsmanager_secret.api_database_url[0].arn, aws_secretsmanager_secret.api_ledger_verifier_url[0].arn, aws_secretsmanager_secret.api_migrator_url[0].arn, aws_secretsmanager_secret.worker_database_url[0].arn, aws_secretsmanager_secret.issuer_database_url[0].arn]', 'resources = ["arn:aws:secretsmanager:${var.region}:${local.audit_account_id}:secret:${local.name}/*"]'],
    ['provisioning task role also reaches a sixth secret (the service invitation key)', 'resources = [aws_secretsmanager_secret.api_database_url[0].arn, aws_secretsmanager_secret.api_ledger_verifier_url[0].arn, aws_secretsmanager_secret.api_migrator_url[0].arn, aws_secretsmanager_secret.worker_database_url[0].arn, aws_secretsmanager_secret.issuer_database_url[0].arn]', 'resources = [aws_secretsmanager_secret.api_database_url[0].arn, aws_secretsmanager_secret.api_ledger_verifier_url[0].arn, aws_secretsmanager_secret.api_migrator_url[0].arn, aws_secretsmanager_secret.worker_database_url[0].arn, aws_secretsmanager_secret.issuer_database_url[0].arn, aws_secretsmanager_secret.api_invitation_digest_key[0].arn]'],
    ['provisioning task role reads only four secrets and the issuer by prefix', 'resources = [aws_secretsmanager_secret.api_database_url[0].arn, aws_secretsmanager_secret.api_ledger_verifier_url[0].arn, aws_secretsmanager_secret.api_migrator_url[0].arn, aws_secretsmanager_secret.worker_database_url[0].arn, aws_secretsmanager_secret.issuer_database_url[0].arn]', 'resources = [aws_secretsmanager_secret.api_database_url[0].arn, aws_secretsmanager_secret.api_ledger_verifier_url[0].arn, aws_secretsmanager_secret.api_migrator_url[0].arn, aws_secretsmanager_secret.worker_database_url[0].arn, "arn:aws:secretsmanager:*:*:secret:${local.name}/issuer/*"]'],
    ['provisioning execution role gains the issuer secret', 'resources = [aws_db_instance.main.master_user_secret[0].secret_arn]', 'resources = [aws_db_instance.main.master_user_secret[0].secret_arn, aws_secretsmanager_secret.issuer_database_url[0].arn]'],
    ['the service execution role gains the issuer secret', 'aws_secretsmanager_secret.api_identifier_digest_key[0].arn, aws_secretsmanager_secret.api_tls_cert[0].arn, aws_secretsmanager_secret.api_tls_key[0].arn]', 'aws_secretsmanager_secret.api_identifier_digest_key[0].arn, aws_secretsmanager_secret.api_tls_cert[0].arn, aws_secretsmanager_secret.api_tls_key[0].arn, aws_secretsmanager_secret.issuer_database_url[0].arn]'],
    ['the migration execution role gains the issuer secret', 'resources = [aws_secretsmanager_secret.api_migrator_url[0].arn]', 'resources = [aws_secretsmanager_secret.api_migrator_url[0].arn, aws_secretsmanager_secret.issuer_database_url[0].arn]'],
    ['the service task injects the issuer secret', '        { name = "IDENTIFIER_DIGEST_KEY", valueFrom = aws_secretsmanager_secret.api_identifier_digest_key[0].arn },\n', '        { name = "IDENTIFIER_DIGEST_KEY", valueFrom = aws_secretsmanager_secret.api_identifier_digest_key[0].arn },\n        { name = "ISSUER_DATABASE_URL", valueFrom = aws_secretsmanager_secret.issuer_database_url[0].arn },\n'],
    ['provisioning task not counted by the image', 'resource "aws_ecs_task_definition" "api_provision" {\n  count                    = local.api_service_count', 'resource "aws_ecs_task_definition" "api_provision" {\n  count                    = local.api_count'],
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
    ['cli.ts reads a renamed issuer variable', { cli: cliSource.replace('process.env.PROVISION_SECRET_ISSUER ? { issuer: process.env.PROVISION_SECRET_ISSUER }', 'process.env.PROVISION_SECRET_SESSION_ISSUER ? { issuer: process.env.PROVISION_SECRET_SESSION_ISSUER }') }],
    ['cli.ts stops reading the issuer variable', { cli: cliSource.replace('...(process.env.PROVISION_SECRET_ISSUER ? { issuer: process.env.PROVISION_SECRET_ISSUER } : {})', '') }],
    ['cli.ts reads an extra provisioning secret Terraform does not pass', { cli: cliSource.replace("worker: required('PROVISION_SECRET_WORKER')", "worker: required('PROVISION_SECRET_WORKER'), extra: required('PROVISION_SECRET_EXTRA')") }],
  ];
  for (const [name, sources] of applicationSide) assert.ok(apiComputeProblems(compute, sources).length > 0, `a changed application must be reported: ${name}`);
  assert.deepEqual(apiComputeProblems(compute), []); // control: the unchanged text is clean
});
