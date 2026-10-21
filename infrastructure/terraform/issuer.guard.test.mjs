// Guards for the session issuer's compute (issuer.tf; DATA-01 slice 2b). Imported by guard.test.mjs, so `pnpm test:infra` runs it.
// Like the other guards it reads Terraform TEXT: it cannot prove what AWS will do once applied. `issuerProblems` returns what is wrong with a copy of the text
// (empty when nothing is); the tests run it on the real files and on deliberately broken copies, so every rule has been seen to fail.
//
// The issuer exists so that the API cannot mint its own tenant. Two sets of rules therefore matter more than the rest, and each has controls below:
//  - separation: no role of the API (or the worker, or the provisioning task) can read the issuer's secret, and nothing the API owns can use the issuer's roles;
//  - reach: the issuer accepts one connection source (the API tasks, on the issuer port) and sends out only to the database and HTTPS.
// What cannot be judged from text is stated in the transport addendum: nothing is applied, so latency and the real behaviour of Service Connect are unmeasured.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const dir = new URL('./', import.meta.url);
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const issuer = read('./issuer.tf');
const issuerCoreSource = read('../../apps/backend/src/issuer/issuer-core.ts');
const migration0028 = read('../../apps/backend/migrations/0028_tenant_capability.up.sql');
const dockerfile = read('../docker/api.Dockerfile');
/** Every other Terraform file in the root, by name: the separation rules read all of them. */
const others = Object.fromEntries(readdirSync(dir).filter((f) => f.endsWith('.tf') && f !== 'issuer.tf').map((f) => [f, read(`./${f}`)]));

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

const SECRET_REF = String.raw`(?:aws_secretsmanager_secret\.\w+\[0\]\.arn|aws_db_instance\.main\.master_user_secret\[0\]\.secret_arn)`;
const SECRET_LIST = new RegExp(String.raw`^\[\s*${SECRET_REF}(?:\s*,\s*${SECRET_REF})*\s*\]$`);

/** What is wrong with the issuer Terraform text `tf`, given every OTHER Terraform file by name (`rest`) and the application sources it must agree with, as a list of sentences. */
export function issuerProblems(tf, rest = others, sources = {}) {
  const core = sources.core ?? issuerCoreSource;
  const migration = sources.migration ?? migration0028;
  const docker = sources.docker ?? dockerfile;
  const problems = [];
  const text = code(tf);
  const need = (condition, why) => {
    if (!condition) problems.push(why);
  };
  const has = (haystack, fragment) => squash(code(haystack)).includes(squash(fragment));
  const one = (header, from = text) => blocks(from, header)[0] ?? '';
  /** A whole line, so `threshold = 5` is not satisfied by `threshold = 50`. */
  const line = (haystack, fragment) => code(haystack).split('\n').some((l) => squash(l).trim() === squash(fragment));

  // Counting: foundations by the hosting switch; the task, the service and the alarms that need a running service by the issuer switch; the TLS role by a named CA.
  const resources = [...text.matchAll(/^resource "([^"]+)" "([^"]+)"/gm)];
  need(resources.length >= 18, 'the scan must find the resources (a floor, so an empty read cannot pass)');
  const SERVICE_ONLY = new Set(['aws_ecs_task_definition.issuer', 'aws_ecs_service.issuer', 'aws_cloudwatch_metric_alarm.issuer_running_tasks', 'aws_cloudwatch_metric_alarm.issuer_cpu_high']);
  const TLS_ONLY = new Set(['aws_iam_role.issuer_service_connect_tls', 'aws_iam_role_policy.issuer_service_connect_tls']);
  for (const [header, type, name] of resources) {
    const b = blocks(text, header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))[0] ?? '';
    const key = `${type}.${name}`;
    const want = SERVICE_ONLY.has(key) ? 'local.issuer_service_count' : TLS_ONLY.has(key) ? 'local.issuer_tls_count' : 'local.api_count';
    need(has(b, `count = ${want}`), `${key} must be counted by ${want}`);
  }
  need(has(text, 'issuer_service_count = local.api_service_count == 1 && var.enable_issuer ? 1 : 0'), 'the service must need hosting, an image AND the issuer switch');
  need(has(text, 'issuer_tls_count = local.api_count == 1 && var.issuer_tls_ca_arn != "" ? 1 : 0'), 'the certificate role must need hosting and a named Private CA');

  // The switch is off until the application can start: the image must build the entry the task runs.
  const sw = one('variable "enable_issuer"');
  need(has(sw, 'type = bool') && has(sw, 'default = false'), 'enable_issuer must be a bool that defaults to false');
  need(!/default\s*=\s*true/.test(code(sw)) || /issuer\/main\.js/.test(docker), 'the issuer switch may default to true only once the image builds issuer/main.js');
  const count = one('variable "issuer_desired_count"');
  need(has(count, 'default = 1') && has(count, 'var.issuer_desired_count >= 1 && var.issuer_desired_count <= 10'), 'issuer_desired_count must default to 1 and stay between 1 and 10');
  const tlsVar = one('variable "issuer_tls_ca_arn"');
  need(has(tlsVar, 'default = ""') && has(tlsVar, 'arn:aws:acm-pca:') && has(tlsVar, 'certificate-authority/'), 'issuer_tls_ca_arn must default to empty and accept only a Private CA ARN');

  // The secret: a container, encrypted, no value, readable by nothing of the API's.
  need(!/aws_secretsmanager_secret_version|secret_string|secret_binary/.test(text), 'no secret value may be in Terraform');
  const secret = one('resource "aws_secretsmanager_secret" "issuer_database_url"');
  need(has(secret, 'kms_key_id = aws_kms_key.data.arn') && has(secret, 'recovery_window_in_days = local.secret_recovery_days'), 'the issuer secret must use the data key and the profile recovery window');
  need(has(secret, 'name = "${local.name}/issuer/database-url"'), 'the issuer secret must live under its own name, not the API\'s');

  // Separation, seen from every other file: nothing outside issuer.tf may name the issuer's secret, roles or security group, and no secrets policy anywhere may be wider than named secrets.
  for (const [file, body] of Object.entries(rest)) {
    const t = code(body);
    need(!/issuer_database_url|\/issuer\/|aws_iam_role\.issuer_|aws_iam_role_policy[a-z_]*\.issuer_|aws_security_group\.issuer_tasks|data\.aws_iam_policy_document\.issuer_/.test(t), `${file} must not reach the issuer's secret, roles, policies or security group`);
    for (const s of statements(t)) {
      if (!/secretsmanager:/.test(s.actions)) continue;
      need(!/secretsmanager:\*/.test(s.actions), `${file}: no statement may allow every Secrets Manager action`);
      need(SECRET_LIST.test(s.resources.trim()), `${file}: a Secrets Manager statement (${s.sid || 'unnamed'}) must name its secrets one by one (no wildcard, no prefix): ${s.resources}`);
    }
    need(!/secretsmanager:\*|"secretsmanager:Get\*"|SecretsManagerReadWrite/.test(t), `${file} must hold no Secrets Manager wildcard or managed read policy`);
  }

  // The task role: the issuer's own identity, with no permission at all.
  const taskRole = one('resource "aws_iam_role" "issuer_task"');
  need(has(taskRole, 'assume_role_policy = data.aws_iam_policy_document.api_ecs_assume.json'), 'the issuer task role must use the account-and-source-limited ECS trust');
  need(!/aws_iam_role_policy(_attachment)?" "issuer_task/.test(text) && !/aws_iam_role\.issuer_task\[0\]\.(name|id)\b/.test(text), 'the issuer task role must hold no policy and no attachment (it makes no AWS call)');

  // The execution role: pulls this image, writes its own logs, reads only its own secret.
  const exec = one('data "aws_iam_policy_document" "issuer_execution"');
  const execStatements = statements(exec);
  const secretRead = execStatements.find((s) => s.actions.includes('secretsmanager:GetSecretValue'));
  need(secretRead !== undefined && secretRead.resources.trim() === '[aws_secretsmanager_secret.issuer_database_url[0].arn]', 'the issuer execution role must read the issuer secret and no other');
  need(execStatements.filter((s) => s.actions.includes('secretsmanager:')).length === 1, 'the issuer execution role must have exactly one Secrets Manager statement');
  need(!/api_database_url|api_migrator_url|api_ledger_verifier_url|api_invitation_digest_key|api_identifier_digest_key|worker_database_url|master_user_secret/.test(code(exec)), 'the issuer execution role must not reach any other secret');
  const pull = execStatements.find((s) => s.actions.includes('ecr:BatchGetImage'));
  need(pull !== undefined && pull.resources.trim() === '[local.api_repository]', 'the issuer may pull only this repository');
  const logs = execStatements.find((s) => s.actions.includes('logs:PutLogEvents'));
  need(logs !== undefined && logs.resources.includes('log-group:${local.issuer_log_group}:*'), 'the issuer may write only its own log group');
  const kms = execStatements.find((s) => s.actions.includes('kms:Decrypt'));
  need(kms !== undefined && has(kms.body, 'variable = "kms:ViaService"') && has(kms.body, 'secretsmanager.${var.region}.amazonaws.com'), 'the issuer execution role may use the data key only through Secrets Manager');
  need(!/AmazonECSTaskExecutionRolePolicy|"secretsmanager:\*"|resources\s*=\s*\["\*"\]/.test(code(exec).replace(/actions\s*=\s*\["ecr:GetAuthorizationToken"\]\s*\n\s*resources\s*=\s*\["\*"\]/, '')), 'no broad managed policy and no wildcard (except the ECR login, which has no resource)');
  need(has(one('resource "aws_iam_role_policy" "issuer_execution"'), 'role = aws_iam_role.issuer_execution[0].id') && has(one('resource "aws_iam_role_policy" "issuer_execution"'), 'policy = data.aws_iam_policy_document.issuer_execution[0].json'), 'the execution policy must be attached to the issuer execution role');

  // The certificate role: ECS issues the Service Connect certificate from the ONE named CA.
  const tlsAssume = one('data "aws_iam_policy_document" "issuer_service_connect_tls_assume"');
  need(has(tlsAssume, 'identifiers = ["ecs.amazonaws.com"]') && has(tlsAssume, 'variable = "aws:SourceAccount"'), 'the certificate role may be assumed only by ECS in this account');
  const tlsPolicy = one('data "aws_iam_policy_document" "issuer_service_connect_tls"');
  const tlsStatements = statements(tlsPolicy);
  need(tlsStatements.length === 4, 'the certificate role must have exactly four statements (create, rotate, read the CA, issue)');
  for (const s of tlsStatements.filter((x) => /acm-pca:/.test(x.actions))) need(s.resources.trim() === '[var.issuer_tls_ca_arn]', `certificate statement ${s.sid} must name the one CA`);
  for (const s of tlsStatements.filter((x) => /secretsmanager:/.test(x.actions))) need(/secret:ecs-sc!\*"\]$/.test(s.resources.trim()) && !s.resources.includes('"*"'), `certificate statement ${s.sid} must be limited to the ecs-sc! secrets`);
  need(has(tlsPolicy, '"acm-pca:IssueCertificate"') && has(tlsPolicy, 'arn:aws:acm-pca:::template/EndEntityCertificate/V1') && has(tlsPolicy, 'aws:ResourceTag/AmazonECSManaged'), 'issuing must be limited to end-entity certificates from a CA tagged for ECS');
  need(!/resources\s*=\s*\["\*"\]|acm-pca:\*|secretsmanager:\*|"iam:|"kms:/.test(tlsPolicy), 'the certificate role must hold no wildcard, iam or kms right');

  // Network: ONE way in (the API tasks, on the issuer port); out only to the database and HTTPS.
  need(/issuer_port\s*=\s*(\d+)/.test(text) && Number(/issuer_port\s*=\s*(\d+)/.exec(text)?.[1]) >= 1024 && ![3000, 5432, 8081, 443].includes(Number(/issuer_port\s*=\s*(\d+)/.exec(text)?.[1])), 'the issuer port must be one unprivileged port that is not the API\'s, the worker\'s, the database\'s or HTTPS');
  const sg = one('resource "aws_security_group" "issuer_tasks"');
  need(!/\bingress\b|\begress\b/.test(code(sg)), 'the issuer security group must have no inline rules');
  const ingress = [...text.matchAll(/^resource "aws_vpc_security_group_ingress_rule" "(\w+)"/gm)].map((m) => m[1]);
  /** Every rule of the given kind, in ANY Terraform file, whose own security group is `sgRef`. */
  const everyRuleOn = (sgRef, kind) => [text, ...Object.values(rest).map(code)].flatMap((t) => blocks(t, `resource "aws_vpc_security_group_${kind}_rule" "\\w+"`).filter((b) => new RegExp(`\\bsecurity_group_id\\s*=\\s*aws_security_group\\.${sgRef}`).test(b)));
  const inboundToIssuer = everyRuleOn('issuer_tasks\\[0\\]', 'ingress');
  need(inboundToIssuer.length === 1, `exactly one rule may admit traffic to the issuer tasks (found ${inboundToIssuer.length})`);
  const inbound = one('resource "aws_vpc_security_group_ingress_rule" "issuer_tasks_from_api"');
  need(has(inbound, 'security_group_id = aws_security_group.issuer_tasks[0].id') && has(inbound, 'referenced_security_group_id = aws_security_group.api_tasks[0].id') && has(inbound, 'from_port = local.issuer_port') && has(inbound, 'to_port = local.issuer_port') && has(inbound, 'ip_protocol = "tcp"'), 'the issuer admits the API tasks, on the issuer port, over TCP');
  need(!/cidr_ipv4|cidr_ipv6|prefix_list_id/.test(code(inbound)) && !/ip_protocol\s*=\s*"-1"/.test(code(inbound)), 'the inbound rule must name a security group, not an address range or every protocol');
  need(ingress.includes('issuer_tasks_from_api') && ingress.includes('issuer_db_from_tasks'), 'both ingress rules (issuer from API, database from issuer) must exist');
  const outbound = everyRuleOn('issuer_tasks\\[0\\]', 'egress');
  need(outbound.length === 2, `the issuer tasks must have exactly two egress rules (found ${outbound.length})`);
  const toDb = one('resource "aws_vpc_security_group_egress_rule" "issuer_tasks_to_database"');
  need(has(toDb, 'referenced_security_group_id = aws_security_group.db.id') && has(toDb, 'from_port = 5432') && has(toDb, 'to_port = 5432'), 'the issuer may reach the database on 5432');
  const https = one('resource "aws_vpc_security_group_egress_rule" "issuer_tasks_https_out"');
  need(has(https, 'from_port = 443') && has(https, 'to_port = 443') && has(https, 'cidr_ipv4 = "0.0.0.0/0"') && has(https, 'ip_protocol = "tcp"'), 'the only other way out is HTTPS');
  const dbIn = one('resource "aws_vpc_security_group_ingress_rule" "issuer_db_from_tasks"');
  need(has(dbIn, 'security_group_id = aws_security_group.db.id') && has(dbIn, 'referenced_security_group_id = aws_security_group.issuer_tasks[0].id') && has(dbIn, 'from_port = 5432') && has(dbIn, 'to_port = 5432'), 'the database admits the issuer tasks on 5432 only');
  const apiOut = one('resource "aws_vpc_security_group_egress_rule" "api_tasks_to_issuer"');
  need(has(apiOut, 'security_group_id = aws_security_group.api_tasks[0].id') && has(apiOut, 'referenced_security_group_id = aws_security_group.issuer_tasks[0].id') && has(apiOut, 'from_port = local.issuer_port') && has(apiOut, 'to_port = local.issuer_port'), 'the API tasks may send to the issuer tasks on the issuer port only');
  need(!/aws_lb\b|aws_lb_|load_balancer/.test(text), 'no load balancer may stand in front of the issuer (the entry point is Service Connect)');
  const ns = one('resource "aws_service_discovery_http_namespace" "internal"');
  need(ns !== '' && !/vpc/.test(ns), 'the namespace is a private HTTP namespace');

  // The task and the service.
  const task = one('resource "aws_ecs_task_definition" "issuer"');
  need(has(task, 'task_role_arn = aws_iam_role.issuer_task[0].arn') && has(task, 'execution_role_arn = aws_iam_role.issuer_execution[0].arn'), 'the issuer must use its own two roles');
  need(has(task, 'network_mode = "awsvpc"') && has(task, 'requires_compatibilities = ["FARGATE"]'), 'the issuer must be Fargate with awsvpc networking');
  need(has(task, 'image = var.api_image') && has(task, 'command = ["node", "issuer/main.js"]'), 'the issuer must run the pinned image, started as the issuer bundle');
  need(has(task, 'readonlyRootFilesystem = true') && has(task, 'user = local.api_user'), 'the issuer must have a read-only filesystem and run as the non-root user');
  need(!/\bvolume\s*\{/.test(code(task)) && !/\bmountPoints\b/.test(code(task)), 'the issuer task must declare no volume and mount nothing (it writes no files)');
  need(!/privileged|linuxParameters|"0"/.test(code(task)), 'the issuer must hold no privileged mode, extra Linux parameters or root user');
  need(has(task, 'secrets = [{ name = "DATABASE_URL", valueFrom = aws_secretsmanager_secret.issuer_database_url[0].arn }]'), 'the issuer login must be injected as DATABASE_URL from the issuer secret, and be the only secret');
  need(has(task, 'portMappings = [{ name = "issuer", containerPort = local.issuer_port, protocol = "tcp", appProtocol = "http" }]') && !/hostPort/.test(code(task)), 'the issuer publishes exactly its one named port');
  need(has(task, 'logConfiguration') && has(task, '"awslogs-group" = aws_cloudwatch_log_group.issuer[0].name'), 'the issuer must log to its own group');
  need(has(task, 'healthCheck') && has(task, '/livez'), 'the issuer must be checked on /livez (by the container itself)');
  const service = one('resource "aws_ecs_service" "issuer"');
  need(!/load_balancer/.test(code(service)), 'no load balancer may reach the issuer');
  need(has(service, 'enable_execute_command = false'), 'no shell may be opened into an issuer task');
  need(has(service, 'launch_type = "FARGATE"') && has(service, 'desired_count = var.issuer_desired_count') && has(service, 'cluster = aws_ecs_cluster.api[0].id'), 'the issuer must be Fargate on the API cluster with its own desired count');
  need(has(service, 'security_groups = [aws_security_group.issuer_tasks[0].id]') && has(service, 'subnets = local.data_subnet_ids') && has(service, 'assign_public_ip = local.tasks_public_ip') && !/assign_public_ip\s*=\s*true/.test(code(service)), 'the issuer must sit in its own security group in the data subnets, with a public address only through the synthetic profile');
  need(has(service, 'enable = true') && has(service, 'rollback = true') && has(service, 'deployment_minimum_healthy_percent = 100'), 'a failed deployment must roll back and never reduce healthy capacity');
  need(has(service, 'enabled = true') && has(service, 'namespace = aws_service_discovery_http_namespace.internal[0].arn') && has(service, 'port_name = "issuer"') && has(service, 'port = local.issuer_port'), 'the issuer must register in the Service Connect namespace on its port');
  need(has(service, 'for_each = var.issuer_tls_ca_arn == "" ? [] : [1]') && has(service, 'role_arn = aws_iam_role.issuer_service_connect_tls[0].arn') && has(service, 'aws_pca_authority_arn = var.issuer_tls_ca_arn'), 'a named Private CA must turn Service Connect TLS on, with the certificate role');
  need(has(service, 'var.environment != "production" || var.issuer_desired_count >= 2'), 'production must run at least two issuer tasks');
  need(has(service, 'var.environment != "production" || var.issuer_tls_ca_arn != ""'), 'production must encrypt the issuer connection');

  // The environment: what the issuer core needs, and no login, no override and no test setting.
  const env = blocks(text, 'issuer_environment = ')[0] ?? '';
  const keys = [...env.matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*=/gm)].map((m) => m[1]);
  for (const key of ['NODE_ENV', 'PORT', 'DATABASE_SSL', 'COGNITO_REGION', 'COGNITO_USER_POOL_ID', 'COGNITO_APP_CLIENT_ID']) need(keys.includes(key), `the issuer environment must set ${key}`);
  for (const key of ['DATABASE_URL', 'DATABASE_MIGRATOR_URL', 'DATABASE_ADMIN_URL', 'LEDGER_VERIFIER_DATABASE_URL', 'INVITATION_DIGEST_KEY', 'IDENTIFIER_DIGEST_KEY', 'COGNITO_ISSUER', 'COGNITO_JWKS_URI', 'AUTH_VERIFIER', 'JWT_SECRET', 'S3_ENDPOINT', 'REPORTS_BUCKET']) need(!keys.includes(key), `${key} must not be a plain issuer environment value`);
  need(has(env, 'NODE_ENV = "production"') && has(env, 'DATABASE_SSL = "require"') && has(env, 'PORT = tostring(local.issuer_port)'), 'the issuer must run as production with TLS to the database and one port value');
  need(has(env, 'COGNITO_USER_POOL_ID = aws_cognito_user_pool.main.id') && has(env, 'COGNITO_APP_CLIENT_ID = aws_cognito_user_pool_client.spa.id') && has(env, 'COGNITO_REGION = var.region'), 'the issuer must verify against the same user pool and app client as the API');

  // The log group and its key.
  const key = one('data "aws_iam_policy_document" "issuer_logs_key"');
  need(!/identifiers\s*=\s*\["\*"\]/.test(key) && has(key, 'log-group:${local.issuer_log_group}"'), 'the log key may be used by the log service for the issuer log group only');
  need(has(one('resource "aws_kms_key" "issuer_logs"'), 'enable_key_rotation = true'), 'the issuer log key must rotate');
  const group = one('resource "aws_cloudwatch_log_group" "issuer"');
  need(has(group, 'kms_key_id = aws_kms_key.issuer_logs[0].arn') && has(group, 'retention_in_days = var.api_log_retention_days') && has(group, 'name = local.issuer_log_group'), 'the issuer log group must be encrypted with its own key and use the retention variable');

  // The alarms: each pattern matches a literal the issuer core writes, and a refusal code the database can return.
  const pattern = (name) => /pattern\s*=\s*"(.*)"\s*$/m.exec(one(`resource "aws_cloudwatch_log_metric_filter" "${name}"`))?.[1].replace(/\\"/g, '"') ?? '';
  need(pattern('issuer_unavailable') === '"Capability not issued: unavailable"', 'the unavailable filter must match the issuer\'s unavailable phrase');
  need(pattern('issuer_rate_limited') === '"Capability not issued: refused (rate-limited)"', 'the rate-limit filter must match the issuer\'s refused (rate-limited) phrase');
  need(/`Capability not issued: \$\{reason\}\$\{detail \? ` \(\$\{detail\}\)` : ''\} request=/.test(core) && /this\.refuse\('unavailable', request\)/.test(core) && /Capability not issued: unavailable \(/.test(core), 'the issuer core must still log "Capability not issued: <reason> (<detail>)" and use the reason unavailable');
  need(/'rate-limited'/.test(migration) && /this\.refuse\('refused', request, outcome\.refusal\)/.test(core), 'the database must still return rate-limited and the core must still log it as the detail of a refusal');
  const unavailable = one('resource "aws_cloudwatch_metric_alarm" "issuer_unavailable"');
  need(has(unavailable, 'metric_name = "IssuerUnavailable"') && line(unavailable, 'threshold = 5') && line(unavailable, 'period = 300') && has(unavailable, 'comparison_operator = "GreaterThanOrEqualToThreshold"') && has(unavailable, 'statistic = "Sum"'), 'five unavailable issuances in five minutes must raise the unavailable alarm');
  const limited = one('resource "aws_cloudwatch_metric_alarm" "issuer_rate_limited"');
  need(has(limited, 'metric_name = "IssuerRateLimited"') && line(limited, 'threshold = 10') && line(limited, 'period = 300') && has(limited, 'comparison_operator = "GreaterThanOrEqualToThreshold"'), 'ten rate-limited refusals in five minutes must raise the rate-limit alarm');
  const running = one('resource "aws_cloudwatch_metric_alarm" "issuer_running_tasks"');
  need(has(running, 'metric_name = "RunningTaskCount"') && has(running, 'threshold = var.issuer_desired_count') && has(running, 'comparison_operator = "LessThanThreshold"') && has(running, 'treat_missing_data = "breaching"') && has(running, 'statistic = "Minimum"') && has(running, 'ServiceName = aws_ecs_service.issuer[0].name'), 'fewer running issuer tasks than wanted (or no data at all) must raise the running-tasks alarm');
  const cpu = one('resource "aws_cloudwatch_metric_alarm" "issuer_cpu_high"');
  need(has(cpu, 'metric_name = "CPUUtilization"') && line(cpu, 'threshold = 80') && has(cpu, 'comparison_operator = "GreaterThanThreshold"') && line(cpu, 'evaluation_periods = 3'), 'CPU above 80 percent for three minutes must raise the CPU alarm');
  for (const alarm of ['issuer_unavailable', 'issuer_rate_limited', 'issuer_running_tasks', 'issuer_cpu_high']) {
    const b = one(`resource "aws_cloudwatch_metric_alarm" "${alarm}"`);
    need(has(b, 'alarm_actions = [aws_sns_topic.audit_alarms.arn]'), `the ${alarm} alarm must notify the audit topic`);
  }
  for (const alarm of ['issuer_unavailable', 'issuer_rate_limited']) {
    const b = one(`resource "aws_cloudwatch_metric_alarm" "${alarm}"`);
    need(has(b, 'namespace = local.issuer_metrics') && has(b, 'treat_missing_data = "notBreaching"'), `the ${alarm} alarm must read the issuer metrics namespace, and silence is normal for it`);
  }
  for (const name of ['issuer_secret_arn', 'issuer_service_name', 'issuer_namespace_arn']) need(has(text, `output "${name}"`), `output ${name} is missing`);
  return problems;
}

test('the issuer compute text has no problems (and the scan found the files: a floor, so an empty read cannot pass)', () => {
  assert.ok(issuer.length > 15000 && issuer.includes('resource "aws_ecs_service" "issuer"'));
  assert.ok(Object.keys(others).length >= 15 && others['api-compute.tf']?.includes('api_execution_service') && others['worker.tf']?.includes('worker_execution'));
  assert.deepEqual(issuerProblems(issuer), []);
});

test('the issuer compute guard reports each way the issuer text could be weakened (controls)', () => {
  const weakened = [
    ['the secret container not counted', 'resource "aws_secretsmanager_secret" "issuer_database_url" {\n  count       = local.api_count\n', 'resource "aws_secretsmanager_secret" "issuer_database_url" {\n'],
    ['the service counted by the hosting switch alone', 'resource "aws_ecs_service" "issuer" {\n  count                              = local.issuer_service_count', 'resource "aws_ecs_service" "issuer" {\n  count                              = local.api_count'],
    ['the service no longer needs the issuer switch', 'issuer_service_count = local.api_service_count == 1 && var.enable_issuer ? 1 : 0', 'issuer_service_count = local.api_service_count == 1 ? 1 : 0'],
    ['the issuer switch defaults to on', 'type        = bool\n  default     = false\n}\n\nvariable "issuer_desired_count"', 'type        = bool\n  default     = true\n}\n\nvariable "issuer_desired_count"'],
    ['a secret value in Terraform', 'resource "aws_secretsmanager_secret" "issuer_database_url" {', 'resource "aws_secretsmanager_secret_version" "oops" {\n  count         = local.api_count\n  secret_id     = "x"\n  secret_string = "postgres://x"\n}\n\nresource "aws_secretsmanager_secret" "issuer_database_url" {'],
    ['the secret not encrypted with the data key', 'No API role may read it."\n  kms_key_id  = aws_kms_key.data.arn', 'No API role may read it."\n  kms_key_id  = "alias/aws/secretsmanager"'],
    ['the secret shares the API name', 'name        = "${local.name}/issuer/database-url"', 'name        = "${local.name}/api/issuer-database-url"'],
    ['the task role gets its own policy', 'resource "aws_iam_role" "issuer_execution" {', 'resource "aws_iam_role_policy" "issuer_task" {\n  count  = local.api_count\n  name   = "x"\n  role   = aws_iam_role.issuer_task[0].id\n  policy = "{}"\n}\n\nresource "aws_iam_role" "issuer_execution" {'],
    ['the task role gets the application policy', 'resource "aws_iam_role" "issuer_execution" {', 'resource "aws_iam_role_policy_attachment" "issuer_task_runtime" {\n  count      = local.api_count\n  role       = aws_iam_role.issuer_task[0].name\n  policy_arn = aws_iam_policy.app_runtime.arn\n}\n\nresource "aws_iam_role" "issuer_execution" {'],
    ['the execution role also reads the application secret', 'resources = [aws_secretsmanager_secret.issuer_database_url[0].arn]\n  }', 'resources = [aws_secretsmanager_secret.issuer_database_url[0].arn, aws_secretsmanager_secret.api_database_url[0].arn]\n  }'],
    ['the execution role reads the migrator secret instead', 'resources = [aws_secretsmanager_secret.issuer_database_url[0].arn]\n  }', 'resources = [aws_secretsmanager_secret.api_migrator_url[0].arn]\n  }'],
    ['the execution role reads every secret', 'resources = [aws_secretsmanager_secret.issuer_database_url[0].arn]\n  }', 'resources = ["*"]\n  }'],
    ['pulls from any repository', 'resources = [local.api_repository]', 'resources = ["*"]'],
    ['logs written anywhere', 'resources = ["arn:aws:logs:${var.region}:${local.audit_account_id}:log-group:${local.issuer_log_group}:*"]', 'resources = ["*"]'],
    ['secrets decrypted outside Secrets Manager', 'values   = ["secretsmanager.${var.region}.amazonaws.com"]\n    }\n  }\n}\n\nresource "aws_iam_role" "issuer_execution"', 'values   = ["s3.${var.region}.amazonaws.com"]\n    }\n  }\n}\n\nresource "aws_iam_role" "issuer_execution"'],
    ['the certificate role may issue from any CA', 'actions   = ["acm-pca:IssueCertificate"]\n    resources = [var.issuer_tls_ca_arn]', 'actions   = ["acm-pca:IssueCertificate"]\n    resources = ["*"]'],
    ['the certificate role reaches every secret', 'actions   = ["secretsmanager:CreateSecret", "secretsmanager:TagResource"]\n    resources = ["arn:aws:secretsmanager:${var.region}:${local.audit_account_id}:secret:ecs-sc!*"]', 'actions   = ["secretsmanager:CreateSecret", "secretsmanager:TagResource"]\n    resources = ["*"]'],
    ['any account may assume the certificate role', 'identifiers = ["ecs.amazonaws.com"]\n    }\n    condition {\n      test     = "StringEquals"\n      variable = "aws:SourceAccount"\n      values   = [local.audit_account_id]\n    }', 'identifiers = ["ecs.amazonaws.com"]\n    }'],
    // Ingress: nothing but the API tasks may connect to the issuer.
    ['the issuer admits the whole internet', 'referenced_security_group_id = aws_security_group.api_tasks[0].id\n  ip_protocol                  = "tcp"\n  from_port                    = local.issuer_port', 'cidr_ipv4                    = "0.0.0.0/0"\n  ip_protocol                  = "tcp"\n  from_port                    = local.issuer_port'],
    ['the issuer admits the whole VPC', 'referenced_security_group_id = aws_security_group.api_tasks[0].id\n  ip_protocol                  = "tcp"\n  from_port                    = local.issuer_port', 'cidr_ipv4                    = "10.0.0.0/8"\n  ip_protocol                  = "tcp"\n  from_port                    = local.issuer_port'],
    ['the issuer admits every protocol', 'referenced_security_group_id = aws_security_group.api_tasks[0].id\n  ip_protocol                  = "tcp"\n  from_port                    = local.issuer_port', 'referenced_security_group_id = aws_security_group.api_tasks[0].id\n  ip_protocol                  = "-1"\n  from_port                    = local.issuer_port'],
    ['the issuer admits the load balancer instead', 'referenced_security_group_id = aws_security_group.api_tasks[0].id\n  ip_protocol                  = "tcp"\n  from_port                    = local.issuer_port', 'referenced_security_group_id = aws_security_group.api_alb[0].id\n  ip_protocol                  = "tcp"\n  from_port                    = local.issuer_port'],
    ['the issuer admits a wider port range', 'ip_protocol                  = "tcp"\n  from_port                    = local.issuer_port\n  to_port                      = local.issuer_port\n  description                  = "From the API tasks only"', 'ip_protocol                  = "tcp"\n  from_port                    = 1024\n  to_port                      = local.issuer_port\n  description                  = "From the API tasks only"'],
    ['the inbound rule keeps its source and also gains an address range', 'to_port                      = local.issuer_port\n  description                  = "From the API tasks only"', 'to_port                      = local.issuer_port\n  cidr_ipv4                    = "0.0.0.0/0"\n  description                  = "From the API tasks only"'],
    ['a second connection is admitted to the issuer', 'resource "aws_vpc_security_group_egress_rule" "api_tasks_to_issuer" {', 'resource "aws_vpc_security_group_ingress_rule" "issuer_tasks_ssh" {\n  count             = local.api_count\n  security_group_id = aws_security_group.issuer_tasks[0].id\n  cidr_ipv4         = "0.0.0.0/0"\n  ip_protocol       = "tcp"\n  from_port         = 22\n  to_port           = 22\n}\n\nresource "aws_vpc_security_group_egress_rule" "api_tasks_to_issuer" {'],
    ['an inline ingress block', 'resource "aws_security_group" "issuer_tasks" {\n  count       = local.api_count', 'resource "aws_security_group" "issuer_tasks" {\n  ingress {\n    from_port = 0\n    to_port   = 0\n    protocol  = "-1"\n  }\n  count       = local.api_count'],
    ['the issuer port is the API\'s', 'issuer_port = 8082', 'issuer_port = 3000'],
    ['the issuer port is privileged', 'issuer_port = 8082', 'issuer_port = 80'],
    // Egress: only the database and HTTPS.
    ['the issuer may send anywhere', 'resource "aws_vpc_security_group_egress_rule" "issuer_tasks_https_out" {\n  count             = local.api_count\n  security_group_id = aws_security_group.issuer_tasks[0].id\n  cidr_ipv4         = "0.0.0.0/0"\n  ip_protocol       = "tcp"\n  from_port         = 443', 'resource "aws_vpc_security_group_egress_rule" "issuer_tasks_https_out" {\n  count             = local.api_count\n  security_group_id = aws_security_group.issuer_tasks[0].id\n  cidr_ipv4         = "0.0.0.0/0"\n  ip_protocol       = "tcp"\n  from_port         = 0'],
    ['a third way out', 'resource "aws_vpc_security_group_ingress_rule" "issuer_db_from_tasks" {', 'resource "aws_vpc_security_group_egress_rule" "issuer_tasks_anywhere" {\n  count             = local.api_count\n  security_group_id = aws_security_group.issuer_tasks[0].id\n  cidr_ipv4         = "0.0.0.0/0"\n  ip_protocol       = "-1"\n}\n\nresource "aws_vpc_security_group_ingress_rule" "issuer_db_from_tasks" {'],
    ['the database port widened', 'referenced_security_group_id = aws_security_group.db.id\n  ip_protocol                  = "tcp"\n  from_port                    = 5432\n  to_port                      = 5432\n  description                  = "PostgreSQL"', 'referenced_security_group_id = aws_security_group.db.id\n  ip_protocol                  = "tcp"\n  from_port                    = 0\n  to_port                      = 5432\n  description                  = "PostgreSQL"'],
    ['the database admits the wrong group', 'security_group_id            = aws_security_group.db.id\n  referenced_security_group_id = aws_security_group.issuer_tasks[0].id', 'security_group_id            = aws_security_group.db.id\n  referenced_security_group_id = aws_security_group.api_tasks[0].id'],
    ['the API may send to any port of the issuer', 'from_port                    = local.issuer_port\n  to_port                      = local.issuer_port\n  description                  = "To the session issuer tasks only"', 'from_port                    = 0\n  to_port                      = 65535\n  description                  = "To the session issuer tasks only"'],
    ['a load balancer is put in front', 'resource "aws_service_discovery_http_namespace" "internal" {', 'resource "aws_lb" "issuer" {\n  internal = false\n}\n\nresource "aws_service_discovery_http_namespace" "internal" {'],
    // The task and the service.
    ['the issuer uses the API roles', 'task_role_arn            = aws_iam_role.issuer_task[0].arn', 'task_role_arn            = aws_iam_role.api_task[0].arn'],
    ['the issuer uses the API execution role', 'execution_role_arn       = aws_iam_role.issuer_execution[0].arn', 'execution_role_arn       = aws_iam_role.api_execution_service[0].arn'],
    ['root filesystem writable', 'readonlyRootFilesystem = true\n      command', 'readonlyRootFilesystem = false\n      command'],
    ['container runs as root', 'user                   = local.api_user\n      readonlyRootFilesystem = true\n      command', 'user                   = "0"\n      readonlyRootFilesystem = true\n      command'],
    ['the issuer started as the API', 'command                = ["node", "issuer/main.js"]', 'command                = ["node", "dist/main.js"]'],
    ['an ephemeral volume is declared', '  runtime_platform {\n    operating_system_family = "LINUX"', '  volume {\n    name = "scratch"\n  }\n\n  runtime_platform {\n    operating_system_family = "LINUX"'],
    ['image is a free variable', 'image                  = var.api_image\n      essential              = true\n      user                   = local.api_user\n      readonlyRootFilesystem = true\n      command', 'image                  = "x:latest"\n      essential              = true\n      user                   = local.api_user\n      readonlyRootFilesystem = true\n      command'],
    ['the issuer holds the application login too', 'secrets                = [{ name = "DATABASE_URL", valueFrom = aws_secretsmanager_secret.issuer_database_url[0].arn }]', 'secrets                = [{ name = "DATABASE_URL", valueFrom = aws_secretsmanager_secret.issuer_database_url[0].arn }, { name = "APP_DATABASE_URL", valueFrom = aws_secretsmanager_secret.api_database_url[0].arn }]'],
    ['the issuer holds the application login instead', 'secrets                = [{ name = "DATABASE_URL", valueFrom = aws_secretsmanager_secret.issuer_database_url[0].arn }]', 'secrets                = [{ name = "DATABASE_URL", valueFrom = aws_secretsmanager_secret.api_database_url[0].arn }]'],
    ['a second port is published', 'portMappings           = [{ name = "issuer", containerPort = local.issuer_port, protocol = "tcp", appProtocol = "http" }]', 'portMappings           = [{ name = "issuer", containerPort = local.issuer_port, hostPort = local.issuer_port, protocol = "tcp", appProtocol = "http" }]'],
    ['the health check removed', '/livez', '/x'],
    ['a shell can be opened', 'enable_execute_command             = false', 'enable_execute_command             = true'],
    ['a load balancer reaches the issuer', 'deployment_circuit_breaker {', 'load_balancer {\n    target_group_arn = aws_lb_target_group.api[0].arn\n    container_name   = "issuer"\n    container_port   = 8082\n  }\n\n  deployment_circuit_breaker {'],
    ['a public address always', 'assign_public_ip = local.tasks_public_ip\n  }\n\n  service_connect_configuration', 'assign_public_ip = true\n  }\n\n  service_connect_configuration'],
    ['the issuer in the API security group', 'security_groups  = [aws_security_group.issuer_tasks[0].id]', 'security_groups  = [aws_security_group.api_tasks[0].id]'],
    ['rollback dropped', 'rollback = true', 'rollback = false'],
    ['the issuer leaves the namespace', 'namespace = aws_service_discovery_http_namespace.internal[0].arn', 'namespace = "other"'],
    ['TLS dropped from the service', 'for_each = var.issuer_tls_ca_arn == "" ? [] : [1]', 'for_each = []'],
    ['production may run one issuer task', 'var.environment != "production" || var.issuer_desired_count >= 2', 'true'],
    ['production may run without TLS', 'var.environment != "production" || var.issuer_tls_ca_arn != ""', 'true'],
    ['the issuer may be scaled to none', 'var.issuer_desired_count >= 1 && var.issuer_desired_count <= 10', 'var.issuer_desired_count >= 0'],
    ['a development override in the environment', '    DATABASE_SSL          = "require"', '    COGNITO_JWKS_URI      = "https://evil.example.com/jwks.json"\n    DATABASE_SSL          = "require"'],
    ['the login as plain environment', '    DATABASE_SSL          = "require"', '    DATABASE_URL          = "postgres://x"\n    DATABASE_SSL          = "require"'],
    ['database TLS off', 'DATABASE_SSL          = "require"', 'DATABASE_SSL          = "disable"'],
    ['a different user pool', 'COGNITO_USER_POOL_ID  = aws_cognito_user_pool.main.id', 'COGNITO_USER_POOL_ID  = "us-east-1_example"'],
    ['log key for any group', 'values   = ["arn:aws:logs:${var.region}:${local.audit_account_id}:log-group:${local.issuer_log_group}"]', 'values   = ["*"]'],
    ['log key does not rotate', 'description             = "${local.name} issuer logs"\n  enable_key_rotation     = true', 'description             = "${local.name} issuer logs"\n  enable_key_rotation     = false'],
    ['the unavailable pattern misses the phrase', '"\\"Capability not issued: unavailable\\""', '"\\"Capability not issued: down\\""'],
    ['the rate-limit pattern misses the detail', '\\"Capability not issued: refused (rate-limited)\\"', '\\"Capability not issued: refused\\"'],
    ['the unavailable alarm threshold raised', 'threshold           = 5', 'threshold           = 500'],
    ['the rate-limit alarm threshold raised', 'threshold           = 10', 'threshold           = 1000'],
    ['silence is a breach for the unavailable alarm', 'comparison_operator = "GreaterThanOrEqualToThreshold"\n  treat_missing_data  = "notBreaching"\n  alarm_actions       = [aws_sns_topic.audit_alarms.arn]\n  depends_on          = [aws_cloudwatch_log_metric_filter.issuer_unavailable]', 'comparison_operator = "GreaterThanOrEqualToThreshold"\n  treat_missing_data  = "breaching"\n  alarm_actions       = [aws_sns_topic.audit_alarms.arn]\n  depends_on          = [aws_cloudwatch_log_metric_filter.issuer_unavailable]'],
    ['silence is fine for the running-tasks alarm', 'comparison_operator = "LessThanThreshold"\n  treat_missing_data  = "breaching"', 'comparison_operator = "LessThanThreshold"\n  treat_missing_data  = "notBreaching"'],
    ['the running-tasks alarm ignores the desired count', 'threshold           = var.issuer_desired_count', 'threshold           = 1'],
    ['the CPU alarm needs one minute only', 'evaluation_periods  = 3\n  threshold           = 80', 'evaluation_periods  = 1\n  threshold           = 80'],
    ['an alarm tells nobody', 'alarm_description   = "The session issuer failed five or more issuances in five minutes because the database did not answer. Once enforcement is on, requests fail with 503 (DATA-01 decision D4)."\n  namespace           = local.issuer_metrics\n  metric_name         = "IssuerUnavailable"\n  statistic           = "Sum"\n  period              = 300\n  evaluation_periods  = 1\n  threshold           = 5\n  comparison_operator = "GreaterThanOrEqualToThreshold"\n  treat_missing_data  = "notBreaching"\n  alarm_actions       = [aws_sns_topic.audit_alarms.arn]', 'alarm_description   = "x"\n  namespace           = local.issuer_metrics\n  metric_name         = "IssuerUnavailable"\n  statistic           = "Sum"\n  period              = 300\n  evaluation_periods  = 1\n  threshold           = 5\n  comparison_operator = "GreaterThanOrEqualToThreshold"\n  treat_missing_data  = "notBreaching"\n  alarm_actions       = []'],
    ['an output missing', 'output "issuer_service_name"', 'output "issuer_service"'],
  ];
  for (const [name, from, to] of weakened) {
    assert.ok(issuer.includes(from), `the control for "${name}" must match the real text (it does not: fix the control)`);
    assert.equal(issuer.split(from).length, 2, `the control for "${name}" must match exactly once`);
    assert.ok(issuerProblems(issuer.replace(from, to)).length > 0, `a weakened text must be reported: ${name}`);
  }
  assert.deepEqual(issuerProblems(issuer), []); // control: the unchanged text is clean
});

test('the issuer guard reports every way another file could let the API (or anything else) reach the issuer (controls)', () => {
  const change = (file, from, to) => {
    assert.ok(others[file].includes(from), `the control for ${file} must match the real text: ${from.slice(0, 60)}`);
    assert.equal(others[file].split(from).length, 2, `the control for ${file} must match exactly once: ${from.slice(0, 60)}`);
    return { ...others, [file]: others[file].replace(from, to) };
  };
  const service = 'resources = [aws_secretsmanager_secret.api_database_url[0].arn, aws_secretsmanager_secret.api_ledger_verifier_url[0].arn, aws_secretsmanager_secret.api_invitation_digest_key[0].arn, aws_secretsmanager_secret.api_identifier_digest_key[0].arn]';
  const weakened = [
    ['the API execution role reads the issuer secret', change('api-compute.tf', service, `${service.slice(0, -1)}, aws_secretsmanager_secret.issuer_database_url[0].arn]`)],
    ['the API execution role reads every secret', change('api-compute.tf', service, 'resources = ["*"]')],
    ['the API execution role reads every secret by prefix', change('api-compute.tf', service, 'resources = ["arn:aws:secretsmanager:${var.region}:${local.audit_account_id}:secret:${local.name}/*"]')],
    ['the API execution role may use every secrets action', change('api-compute.tf', 'sid       = "ReadTheRuntimeSecrets"\n    actions   = ["secretsmanager:GetSecretValue"]', 'sid       = "ReadTheRuntimeSecrets"\n    actions   = ["secretsmanager:*"]')],
    ['the API task definition injects the issuer secret', change('api-compute.tf', '{ name = "IDENTIFIER_DIGEST_KEY", valueFrom = aws_secretsmanager_secret.api_identifier_digest_key[0].arn },', '{ name = "IDENTIFIER_DIGEST_KEY", valueFrom = aws_secretsmanager_secret.api_identifier_digest_key[0].arn },\n        { name = "ISSUER_DATABASE_URL", valueFrom = aws_secretsmanager_secret.issuer_database_url[0].arn },')],
    ['the API service runs with the issuer execution role', change('api-compute.tf', 'execution_role_arn       = aws_iam_role.api_execution_service[0].arn', 'execution_role_arn       = aws_iam_role.issuer_execution[0].arn')],
    ['the API task role gets the issuer policy document', change('api-compute.tf', 'resource "aws_iam_role_policy" "api_execution_service" {\n  count  = local.api_count\n  name   = "start-the-service"\n  role   = aws_iam_role.api_execution_service[0].id\n  policy = data.aws_iam_policy_document.api_execution_service[0].json', 'resource "aws_iam_role_policy" "api_execution_service" {\n  count  = local.api_count\n  name   = "start-the-service"\n  role   = aws_iam_role.api_execution_service[0].id\n  policy = data.aws_iam_policy_document.issuer_execution[0].json')],
    ['the provisioning task role may write the issuer secret by prefix', change('api-compute.tf', 'resources = [aws_secretsmanager_secret.api_database_url[0].arn, aws_secretsmanager_secret.api_ledger_verifier_url[0].arn, aws_secretsmanager_secret.api_migrator_url[0].arn, aws_secretsmanager_secret.worker_database_url[0].arn]', 'resources = ["arn:aws:secretsmanager:*:*:secret:${local.name}/*"]')],
    ['the worker execution role reads the issuer secret', change('worker.tf', 'resources = [aws_secretsmanager_secret.worker_database_url[0].arn]\n  }\n  statement {\n    sid       = "DecryptSecretsThroughSecretsManager"', 'resources = [aws_secretsmanager_secret.worker_database_url[0].arn, aws_secretsmanager_secret.issuer_database_url[0].arn]\n  }\n  statement {\n    sid       = "DecryptSecretsThroughSecretsManager"')],
    ['the database admits the issuer group from the API file', { ...others, 'api-edge.tf': `${others['api-edge.tf']}\nresource "aws_vpc_security_group_ingress_rule" "x" {\n  security_group_id = aws_security_group.issuer_tasks[0].id\n  cidr_ipv4         = "0.0.0.0/0"\n  ip_protocol       = "-1"\n}\n` }],
    ['the API file adds a second way into the issuer', { ...others, 'api-edge.tf': `${others['api-edge.tf']}\nresource "aws_vpc_security_group_ingress_rule" "y" {\n  security_group_id            = aws_security_group.issuer_tasks[0].id\n  referenced_security_group_id = aws_security_group.api_alb[0].id\n  ip_protocol                  = "tcp"\n  from_port                    = 8082\n  to_port                      = 8082\n}\n` }],
    ['a managed read-write secrets policy is attached anywhere', { ...others, 'iam.tf': `${others['iam.tf']}\nresource "aws_iam_role_policy_attachment" "z" {\n  role       = "x"\n  policy_arn = "arn:aws:iam::aws:policy/SecretsManagerReadWrite"\n}\n` }],
  ];
  for (const [name, rest] of weakened) assert.ok(issuerProblems(issuer, rest).length > 0, `a weakened copy of another file must be reported: ${name}`);
  assert.deepEqual(issuerProblems(issuer, others), []); // control: the unchanged files are clean
});

test('the issuer guard reports a changed application side (controls)', () => {
  const weakened = [
    ['the core stops logging the reason', { core: issuerCoreSource.replace('Capability not issued: ${reason}', 'Refused: ${reason}') }],
    ['the core stops using unavailable', { core: issuerCoreSource.replaceAll("'unavailable'", "'down'") }],
    ['the core stops logging the detail', { core: issuerCoreSource.replace('${detail ? ` (${detail})` : \'\'}', '') }],
    ['the core stops refusing with the database code', { core: issuerCoreSource.replace("this.refuse('refused', request, outcome.refusal)", "this.refuse('refused', request)") }],
    ['the database stops returning rate-limited', { migration: migration0028.replaceAll("'rate-limited'", "'too-many'") }],
  ];
  for (const [name, sources] of weakened) assert.ok(issuerProblems(issuer, others, sources).length > 0, `a changed application side must be reported: ${name}`);
  // The tripwire: a text whose switch defaults to on is clean only when the image builds the entry the task runs.
  const on = issuer.replace('type        = bool\n  default     = false\n}\n\nvariable "issuer_desired_count"', 'type        = bool\n  default     = true\n}\n\nvariable "issuer_desired_count"');
  assert.notEqual(on, issuer);
  assert.ok(issuerProblems(on, others, { docker: dockerfile }).length > 0, 'the switch may not default to on while the image lacks the issuer entry');
  assert.equal(issuerProblems(on, others, { docker: `${dockerfile}\nRUN cp apps/backend/dist/issuer/main.js /output/issuer/main.js\n` }).filter((p) => /switch may default/.test(p)).length, 0);
  assert.deepEqual(issuerProblems(issuer), []);
});
