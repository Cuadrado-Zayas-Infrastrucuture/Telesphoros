// Guards for the API's edge (api-edge.tf). Imported by guard.test.mjs, so `pnpm test:infra` runs it.
// Like the other guards it reads Terraform TEXT: it cannot prove what AWS will do once applied. `apiEdgeProblems` returns what is wrong with a
// copy of the text (empty when nothing is); the tests run it on the real file and on deliberately broken copies, so every rule has been seen to fail.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const edge = read('./api-edge.tf');
const variables = read('./variables.tf');
const database = read('./database.tf');
const appEnv = read('../../apps/backend/src/config/env.ts');
const appFactory = read('../../apps/backend/src/app.factory.ts');
const appHealth = read('../../apps/backend/src/health/health.controller.ts');
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

/** The value written for `key = value` inside one block (first match), whitespace squashed; '' when absent. */
function attr(block, key) {
  const m = new RegExp(`^\\s*${key}\\s*=\\s*(.+)$`, 'm').exec(block);
  return m ? squash(m[1]).trim() : '';
}

const INGRESS = {
  api_alb_https: { sg: 'aws_security_group.api_alb[0].id', cidr: '"0.0.0.0/0"', port: '443' },
  api_tasks_from_alb: { sg: 'aws_security_group.api_tasks[0].id', from: 'aws_security_group.api_alb[0].id', port: 'local.api_port' },
  api_db_from_tasks: { sg: 'aws_security_group.db.id', from: 'aws_security_group.api_tasks[0].id', port: '5432' },
};
const EGRESS = {
  api_alb_to_tasks: { sg: 'aws_security_group.api_alb[0].id', to: 'aws_security_group.api_tasks[0].id', port: 'local.api_port' },
  api_tasks_to_database: { sg: 'aws_security_group.api_tasks[0].id', to: 'aws_security_group.db.id', port: '5432' },
  api_tasks_https_out: { sg: 'aws_security_group.api_tasks[0].id', cidr: '"0.0.0.0/0"', port: '443' },
};
const MANAGED_GROUPS = ['AWSManagedRulesAmazonIpReputationList', 'AWSManagedRulesKnownBadInputsRuleSet', 'AWSManagedRulesCommonRuleSet'];

/** What is wrong with the API-edge Terraform text `tf` (with the variables and database text it works with), as a list of sentences. */
export function apiEdgeProblems(tf, vars = variables, db = database) {
  const problems = [];
  const text = code(tf);
  const need = (condition, why) => {
    if (!condition) problems.push(why);
  };
  const has = (haystack, fragment) => squash(code(haystack)).includes(squash(fragment));
  const one = (header) => blocks(text, header)[0] ?? '';

  // Off by default, and every resource counted by the one switch.
  need(has(one('variable "enable_api_hosting"'), 'default = false'), 'enable_api_hosting must default to false');
  need(has(text, 'api_count = var.enable_api_hosting ? 1 : 0'), 'api_count must come from enable_api_hosting alone');
  const resources = [...text.matchAll(/^resource "([^"]+)" "([^"]+)"/gm)];
  need(resources.length >= 16, 'the scan must find the resources (a floor, so an empty read cannot pass)');
  for (const [header, type, name] of resources) {
    need(has(blocks(text, header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))[0] ?? '', 'count = local.api_count'), `${type}.${name} must be counted by api_count`);
  }

  // Certificate: DNS-validated, and the listener waits for the validation.
  const cert = one('resource "aws_acm_certificate" "api"');
  need(has(cert, 'domain_name = var.api_domain') && has(cert, 'validation_method = "DNS"'), 'the certificate must be for api_domain and DNS-validated');
  need(has(one('resource "aws_acm_certificate_validation" "api"'), 'certificate_arn = aws_acm_certificate.api[0].arn'), 'the certificate validation must wait on the certificate');
  need(has(one('resource "aws_lb_listener" "api_https"'), 'certificate_arn = aws_acm_certificate_validation.api[0].certificate_arn'), 'the listener must use the validated certificate');

  // Load balancer.
  const lb = one('resource "aws_lb" "api"');
  need(has(lb, 'load_balancer_type = "application"'), 'the load balancer must be an application load balancer');
  need(has(lb, 'drop_invalid_header_fields = true'), 'invalid header fields must be dropped');
  need(has(lb, 'desync_mitigation_mode = "strictest"'), 'desync mitigation must be strictest');
  need(has(lb, 'enable_deletion_protection = var.environment == "production"'), 'deletion protection must be on in production');
  need(has(lb, 'subnets = local.alb_subnet_ids'), 'the load balancer must sit in the public subnets (profile.tf: the supplied ones, or the synthetic ones)');
  need(has(lb, 'condition = length(local.alb_subnet_ids) >= 2'), 'at least two public subnets must be required');
  need(!has(text, 'access_logs'), 'access logging must stay off: request lines carry record identifiers (docs/ops/api-hosting.md)');

  // Listener: HTTPS only, TLS 1.2 or newer, everything else a 404.
  const listeners = blocks(text, 'resource "aws_lb_listener" "');
  need(listeners.length === 1, 'there must be exactly one listener (HTTPS)');
  const listener = listeners[0] ?? '';
  need(has(listener, 'port = 443') && has(listener, 'protocol = "HTTPS"'), 'the listener must be HTTPS on 443');
  need(!/port\s*=\s*80\b/.test(text) && !has(listener, 'protocol = "HTTP"'), 'there must be no plain-text listener');
  need(/ssl_policy\s*=\s*"ELBSecurityPolicy-TLS13-1-[23]-/.test(listener), 'the TLS policy must be a TLS 1.3 policy that allows 1.2 at the oldest');
  // A TLS 1.2 floor must be the restricted (-Res-) family: the plain TLS13-1-2 policies also offer CBC-mode suites (AWS ALB policy table, 2026-10-19).
  need(!/ssl_policy\s*=\s*"ELBSecurityPolicy-TLS13-1-2-/.test(listener) || /ssl_policy\s*=\s*"ELBSecurityPolicy-TLS13-1-2-Res-/.test(listener), 'a TLS 1.2 floor must use a -Res- policy (AEAD suites only, no CBC)');
  need(has(listener, 'type = "fixed-response"') && has(listener, 'status_code = "404"'), 'anything but the API must get a fixed 404');
  const rule = one('resource "aws_lb_listener_rule" "api_forward"');
  need(has(rule, 'values = ["/api/*"]') && has(rule, 'target_group_arn = aws_lb_target_group.api[0].arn'), 'only /api/* may be forwarded, to the API target group');

  // Target group: the application's port, and readiness (not liveness) as the health check.
  const group = one('resource "aws_lb_target_group" "api"');
  need(has(group, 'port = local.api_port') && has(group, 'protocol = "HTTPS"') && has(group, 'target_type = "ip"'), 'the target group must be HTTPS to the task port by address (audit FE-02)');
  need(has(group, 'path = local.api_ready_path') && has(group, 'matcher = "200"'), 'the health check must be the readiness route expecting 200');
  need(/health_check \{[^}]*protocol\s*=\s*"HTTPS"/.test(group), 'the health check must use HTTPS to reach the task');
  need(has(text, 'api_port = 3000') && has(text, 'api_ready_path = "/api/v1/ready"'), 'the port and readiness path locals must keep their agreed values');

  // Security groups: rules only, and exactly the agreed rules.
  for (const sg of blocks(text, 'resource "aws_security_group" "')) need(!/^\s*(ingress|egress)\s*\{/m.test(sg), 'security groups must use rule resources, not inline rules');
  need(!/ip_protocol\s*=\s*"-1"/.test(text), 'no rule may allow all protocols');
  for (const [kind, expected] of [['ingress', INGRESS], ['egress', EGRESS]]) {
    const found = [...text.matchAll(new RegExp(`^resource "aws_vpc_security_group_${kind}_rule" "([^"]+)"`, 'gm'))].map((m) => m[1]);
    for (const name of found) need(name in expected, `unexpected ${kind} rule ${name}`);
    for (const [name, want] of Object.entries(expected)) {
      const b = one(`resource "aws_vpc_security_group_${kind}_rule" "${name}"`);
      need(b !== '', `the ${kind} rule ${name} is missing`);
      need(attr(b, 'security_group_id') === want.sg, `${name} must belong to ${want.sg}`);
      const peer = attr(b, 'referenced_security_group_id');
      const cidr = attr(b, 'cidr_ipv4');
      const wantPeer = want.from ?? want.to;
      need(wantPeer ? peer === wantPeer && cidr === '' : cidr === want.cidr && peer === '', `${name} must name ${wantPeer ?? want.cidr} and nothing else`);
      need(attr(b, 'from_port') === want.port && attr(b, 'to_port') === want.port, `${name} must be port ${want.port} only`);
      need(attr(b, 'ip_protocol') === '"tcp"', `${name} must be tcp only`);
      need(attr(b, 'cidr_ipv6') === '', `${name} must not open IPv6`);
    }
  }

  // Firewall.
  const acl = one('resource "aws_wafv2_web_acl" "api"');
  need(has(acl, 'scope = "REGIONAL"'), 'the firewall must be regional (it protects the load balancer)');
  need(has(acl, 'default_action {\n    allow {}'), 'the firewall default must allow (the rules block)');
  for (const group of MANAGED_GROUPS) {
    const rules = blocks(acl, 'rule \\{').filter((r) => r.includes(`name        = "${group}"`) || r.includes(`name = "${group}"`));
    need(rules.length === 1, `the managed group ${group} must be present`);
    need(rules.length === 1 && has(rules[0], 'override_action {\n      none {}') , `the managed group ${group} must not be overridden to count`);
  }
  // The one allowed count: SizeRestrictions_BODY, which body-size-limit below takes over. Any other count stays refused.
  const SIZE_OVERRIDE = /rule_action_override \{\s*name = "SizeRestrictions_BODY"\s*action_to_use \{\s*count \{\}\s*\}\s*\}/;
  need([...acl.matchAll(/rule_action_override \{/g)].length === 1 && SIZE_OVERRIDE.test(acl), 'the only rule override allowed is SizeRestrictions_BODY counted, with body-size-limit blocking it');
  need(!/count\s*\{\s*\}/.test(acl.replace(SIZE_OVERRIDE, '')), 'no firewall rule may be switched to count mode, except the SizeRestrictions_BODY override');
  const sizeRule = blocks(acl, 'rule \\{').find((r) => r.includes('name     = "body-size-limit"')) ?? '';
  need(sizeRule !== '' && sizeRule.includes('priority = 40') && sizeRule.includes('action {\n      block {}'), 'body-size-limit must exist and block');
  need(sizeRule.includes('comparison_operator = "GT"') && sizeRule.includes('size                = 8192') && /body \{\s*oversize_handling = "MATCH"\s*\}/.test(sizeRule), 'body-size-limit must block bodies over 8192 bytes, and count an oversize body (the firewall sees only 8 KB of it) as over the limit');
  need(sizeRule.includes('regex_string = "^/api/v1/reports/[0-9a-fA-F-]{36}/upload-attempts/[0-9a-fA-F-]{36}/bytes$"') && sizeRule.includes('uri_path {}'), 'the upload-route exception must be the exact bytes path, not a prefix');
  need(sizeRule.includes('search_string         = "application/json"') && sizeRule.includes('positional_constraint = "STARTS_WITH"') && sizeRule.includes('name = "content-type"'), 'the JSON exception must match a Content-Type that starts with application/json');
  const ceiling = blocks(acl, 'rate_based_statement')[0] ?? '';
  need(has(ceiling, 'limit = var.api_rate_limit_per_5min') && has(ceiling, 'aggregate_key_type = "IP"') && has(ceiling, 'evaluation_window_sec = 300'), 'the per-address ceiling must use the variable, per address, over five minutes');
  need(has(acl, 'action {\n      block {}'), 'the per-address ceiling must block');
  const visibilities = blocks(acl, 'visibility_config');
  need(visibilities.length === 6, 'every rule and the firewall itself must declare visibility (6)');
  for (const v of visibilities) need(has(v, 'sampled_requests_enabled = false') && has(v, 'cloudwatch_metrics_enabled = true'), 'sampled requests must stay off (they keep request headers) and metrics on');
  need(!text.includes('aws_wafv2_web_acl_logging_configuration'), 'firewall logging must stay off until a redaction plan exists');
  const association = one('resource "aws_wafv2_web_acl_association" "api"');
  need(has(association, 'resource_arn = aws_lb.api[0].arn') && has(association, 'web_acl_arn = aws_wafv2_web_acl.api[0].arn'), 'the firewall must be attached to the load balancer');
  need(has(one('variable "api_rate_limit_per_5min"'), 'condition     = var.api_rate_limit_per_5min >= 10'), 'the ceiling variable must validate the firewall minimum');

  // The database accepts the tasks; the old requirement is relaxed only behind the switch.
  need(has(db, 'condition = length(var.app_security_group_ids) >= 1 || var.enable_api_hosting'), 'the database must still require an application group unless the API switch is on');
  need(!/validation\s*\{/.test(blocks(code(vars), 'variable "app_security_group_ids"')[0] ?? ''), 'app_security_group_ids must not carry a validation that blocks the API-tasks-only setup');

  // Outputs the later steps and the runbook use.
  for (const name of ['api_alb_dns_name', 'api_validation_cnames', 'api_target_group_arn', 'api_tasks_security_group_id']) need(has(text, `output "${name}"`), `output ${name} is missing`);
  return problems;
}

/** What is wrong with the agreement between the Terraform locals and the application (port, route prefix, readiness route). */
export function appAgreementProblems(env, factory, health) {
  const problems = [];
  if (!/PORT:\s*z\.coerce\.number\(\)[^\n]*\.default\(3000\)/.test(env)) problems.push('the application must default PORT to 3000 (api_port)');
  if (!/API_PREFIX\s*=\s*'api'/.test(factory) || !/defaultVersion:\s*'1'/.test(factory)) problems.push('the application must serve under /api/v1 (api_ready_path and the /api/* rule)');
  if (!/@Get\('ready'\)/.test(health)) problems.push('the application must serve GET ready (the health check)');
  return problems;
}

test('the API edge text has no problems (and the scan found the file: a floor, so an empty read cannot pass)', () => {
  assert.ok(edge.length > 8000 && edge.includes('resource "aws_lb" "api"'));
  assert.deepEqual(apiEdgeProblems(edge), []);
});

test('the Terraform locals agree with the application', () => {
  assert.deepEqual(appAgreementProblems(appEnv, appFactory, appHealth), []);
  assert.ok(appAgreementProblems(appEnv.replace('.default(3000)', '.default(8080)'), appFactory, appHealth).length > 0);
  assert.ok(appAgreementProblems(appEnv, appFactory.replace("API_PREFIX = 'api'", "API_PREFIX = 'x'"), appHealth).length > 0);
  assert.ok(appAgreementProblems(appEnv, appFactory.replace("defaultVersion: '1'", "defaultVersion: '2'"), appHealth).length > 0);
  assert.ok(appAgreementProblems(appEnv, appFactory, appHealth.replace("@Get('ready')", "@Get('x')")).length > 0);
});

test('the API edge guard reports each way the text could be weakened (controls)', () => {
  const weakened = [
    ['switch on by default', 'description = "Opt in only after the hosting plan, costs and first-apply gates have been approved."\n  type        = bool\n  default     = false', 'description = "x"\n  type        = bool\n  default     = true'],
    ['count switch changed', 'api_count = var.enable_api_hosting ? 1 : 0', 'api_count = 1'],
    ['a resource not counted', 'resource "aws_lb_listener_rule" "api_forward" {\n  count        = local.api_count\n', 'resource "aws_lb_listener_rule" "api_forward" {\n'],
    ['certificate not DNS validated', 'validation_method = "DNS"', 'validation_method = "EMAIL"'],
    ['listener ignores validation', 'certificate_arn   = aws_acm_certificate_validation.api[0].certificate_arn', 'certificate_arn   = aws_acm_certificate.api[0].arn'],
    ['invalid headers kept', 'drop_invalid_header_fields = true', 'drop_invalid_header_fields = false'],
    ['desync mitigation weakened', 'desync_mitigation_mode     = "strictest"', 'desync_mitigation_mode     = "defensive"'],
    ['deletion protection off', 'enable_deletion_protection = var.environment == "production"', 'enable_deletion_protection = false'],
    ['one public subnet allowed', 'condition     = length(local.alb_subnet_ids) >= 2', 'condition     = length(local.alb_subnet_ids) >= 1'],
    ['access logs on', '  idle_timeout               = 60\n', '  idle_timeout               = 60\n  access_logs {\n    bucket  = "x"\n    enabled = true\n  }\n'],
    ['plain listener added', 'resource "aws_lb_listener_rule" "api_forward" {', 'resource "aws_lb_listener" "plain" {\n  count             = local.api_count\n  load_balancer_arn = aws_lb.api[0].arn\n  port              = 80\n  protocol          = "HTTP"\n  default_action {\n    type = "forward"\n  }\n}\n\nresource "aws_lb_listener_rule" "api_forward" {'],
    ['old TLS policy', 'ELBSecurityPolicy-TLS13-1-2-Res-PQ-2025-09', 'ELBSecurityPolicy-2016-08'],
    ['TLS 1.2 policy that still offers CBC suites', 'ELBSecurityPolicy-TLS13-1-2-Res-PQ-2025-09', 'ELBSecurityPolicy-TLS13-1-2-2021-06'],
    ['default action forwards', 'type = "fixed-response"', 'type = "forward"'],
    ['everything forwarded', 'values = ["/api/*"]', 'values = ["/*"]'],
    ['wrong task port', 'api_port       = 3000', 'api_port       = 8080'],
    ['liveness health check', 'api_ready_path = "/api/v1/ready"', 'api_ready_path = "/api/v1/health"'],
    ['health check accepts anything', 'matcher             = "200"', 'matcher             = "200-499"'],
    ['inline security group rule', 'description = "Load balancer for ${local.name}: HTTPS from the internet, traffic only to the application"\n  vpc_id      = local.vpc_id', 'description = "x"\n  vpc_id      = local.vpc_id\n  ingress {\n    from_port = 0\n    to_port   = 0\n    protocol  = "-1"\n  }'],
    ['load balancer open on another port', 'from_port         = 443\n  to_port           = 443\n  description       = "HTTPS from the internet (the firewall filters it)"', 'from_port         = 0\n  to_port           = 65535\n  description       = "HTTPS from the internet (the firewall filters it)"'],
    ['tasks open to the internet', 'referenced_security_group_id = aws_security_group.api_alb[0].id\n  ip_protocol                  = "tcp"\n  from_port                    = local.api_port\n  to_port                      = local.api_port\n  description                  = "From the load balancer only"', 'cidr_ipv4                    = "0.0.0.0/0"\n  ip_protocol                  = "tcp"\n  from_port                    = local.api_port\n  to_port                      = local.api_port\n  description                  = "From the load balancer only"'],
    ['tasks may reach any port out', 'from_port         = 443\n  to_port           = 443\n  description       = "HTTPS to AWS services and the Cognito key endpoint"', 'from_port         = 0\n  to_port           = 65535\n  description       = "HTTPS to AWS services and the Cognito key endpoint"'],
    ['database open to the internet', 'referenced_security_group_id = aws_security_group.api_tasks[0].id\n  ip_protocol                  = "tcp"\n  from_port                    = 5432', 'cidr_ipv4                    = "0.0.0.0/0"\n  ip_protocol                  = "tcp"\n  from_port                    = 5432'],
    ['all protocols allowed', 'ip_protocol       = "tcp"\n  from_port         = 443\n  to_port           = 443\n  description       = "HTTPS from the internet', 'ip_protocol       = "-1"\n  from_port         = 443\n  to_port           = 443\n  description       = "HTTPS from the internet'],
    ['IPv6 opened', 'cidr_ipv4         = "0.0.0.0/0"\n  ip_protocol       = "tcp"\n  from_port         = 443\n  to_port           = 443\n  description       = "HTTPS from the internet', 'cidr_ipv4         = "0.0.0.0/0"\n  cidr_ipv6         = "::/0"\n  ip_protocol       = "tcp"\n  from_port         = 443\n  to_port           = 443\n  description       = "HTTPS from the internet'],
    ['an extra ingress rule', 'resource "aws_vpc_security_group_egress_rule" "api_alb_to_tasks" {', 'resource "aws_vpc_security_group_ingress_rule" "api_debug" {\n  count             = local.api_count\n  security_group_id = aws_security_group.api_tasks[0].id\n  cidr_ipv4         = "0.0.0.0/0"\n  ip_protocol       = "tcp"\n  from_port         = 22\n  to_port           = 22\n}\n\nresource "aws_vpc_security_group_egress_rule" "api_alb_to_tasks" {'],
    ['firewall not regional', 'scope = "REGIONAL"', 'scope = "CLOUDFRONT"'],
    ['managed group dropped', 'name        = "AWSManagedRulesKnownBadInputsRuleSet"', 'name        = "SomethingElse"'],
    ['managed group counted only', 'name     = "common"\n    priority = 30\n    override_action {\n      none {}\n    }', 'name     = "common"\n    priority = 30\n    override_action {\n      count {}\n    }'],
    ['ceiling not blocking', 'name     = "per-address-ceiling"\n    priority = 5\n    action {\n      block {}', 'name     = "per-address-ceiling"\n    priority = 5\n    action {\n      count {}'],
    ['ceiling ignores the variable', 'limit                 = var.api_rate_limit_per_5min', 'limit                 = 2000000'],
    ['ceiling per forwarded address', 'aggregate_key_type    = "IP"', 'aggregate_key_type    = "FORWARDED_IP"'],
    ['sampled requests on', 'metric_name                = "${local.name}-api-common"\n      sampled_requests_enabled   = false', 'metric_name                = "${local.name}-api-common"\n      sampled_requests_enabled   = true'],
    ['metrics off', 'cloudwatch_metrics_enabled = true\n      metric_name                = "${local.name}-api-ip-reputation"', 'cloudwatch_metrics_enabled = false\n      metric_name                = "${local.name}-api-ip-reputation"'],
    ['firewall logging added', 'resource "aws_wafv2_web_acl_association" "api" {', 'resource "aws_wafv2_web_acl_logging_configuration" "api" {\n  count = local.api_count\n}\n\nresource "aws_wafv2_web_acl_association" "api" {'],
    ['firewall not attached', 'resource_arn = aws_lb.api[0].arn', 'resource_arn = aws_lb_target_group.api[0].arn'],
    ['ceiling minimum unchecked', 'condition     = var.api_rate_limit_per_5min >= 10 &&', 'condition     = var.api_rate_limit_per_5min >= 1 &&'],
    ['output removed', 'output "api_target_group_arn"', 'output "api_other"'],
    ['size limit raised', 'size                = 8192', 'size                = 65536'],
    ['oversize body no longer counted as over the limit', 'oversize_handling = "MATCH"', 'oversize_handling = "CONTINUE"'],
    ['size rule only counted', 'name     = "body-size-limit"\n    priority = 40\n    action {\n      block {}', 'name     = "body-size-limit"\n    priority = 40\n    action {\n      count {}'],
    ['upload exception widened to any API path', 'regex_string = "^/api/v1/reports/[0-9a-fA-F-]{36}/upload-attempts/[0-9a-fA-F-]{36}/bytes$"', 'regex_string = "^/api/v1/.*$"'],
    ['JSON exception dropped', 'search_string         = "application/json"', 'search_string         = "text/plain"'],
    ['size override moved to another rule', 'name = "SizeRestrictions_BODY"', 'name = "CrossSiteScripting_BODY"'],
    ['a second override added', 'rule_action_override {\n          name = "SizeRestrictions_BODY"', 'rule_action_override {\n          name = "SizeRestrictions_BODY"\n          action_to_use {\n            count {}\n          }\n        }\n        rule_action_override {\n          name = "SizeRestrictions_BODY"'],
  ];
  for (const [name, from, to] of weakened) {
    assert.ok(edge.includes(from), `the control for "${name}" must match the real text (it does not: fix the control)`);
    assert.ok(apiEdgeProblems(edge.replace(from, to)).length > 0, `a weakened text must be reported: ${name}`);
  }
  // The database and variables sides.
  assert.ok(apiEdgeProblems(edge, variables, database.replace('|| var.enable_api_hosting', '')).length > 0, 'the database relaxation must stay behind the switch');
  assert.ok(apiEdgeProblems(edge, variables.replace('variable "app_security_group_ids" {', 'variable "app_security_group_ids" {\n  validation {\n    condition = true\n    error_message = "x"\n  }').replace(/\n {2}default {5}= \[\]\n\}/, '\n}'), database).length > 0, 'a validation that blocks the API-tasks-only setup must be reported');
  assert.deepEqual(apiEdgeProblems(edge), []); // control: the unchanged text is clean
});
