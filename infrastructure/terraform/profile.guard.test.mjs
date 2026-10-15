// Guards for the deployment profile (profile.tf, network-synthetic.tf). Imported by guard.test.mjs, so `pnpm test:infra` runs it.
// Like the other guards it reads Terraform TEXT. `terraform test` (profiles.tftest.hcl) is the proof of what each profile plans; this
// is the ratchet around it: every relaxation the synthetic profile makes must be one that is written down HERE, so a new one (for example a
// literal `deletion_protection = false` in database.tf) cannot slip in without this file changing and someone reading why.
// `profileProblems` returns what is wrong with a set of files (empty when nothing is); the tests run it on the real files and on deliberately
// broken copies, so every rule has been seen to fail.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const dir = new URL('./', import.meta.url);
const read = (name) => readFileSync(new URL(name, dir), 'utf8');
const squash = (s) => s.replace(/[ \t]+/g, ' ').trim();
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

/** The files that define the profile. Everything else in the root only USES it. */
const DEFINING = new Set(['profile.tf', 'network-synthetic.tf']);

/** Files that may READ the profile variable only to report it (an output, a tag): they relax nothing. */
const REPORTS_PROFILE = new Set(['outputs.tf', 'versions.tf']);

/** Names a use of which relaxes (or removes) something in the synthetic profile. */
const RELAXING = /local\.(synthetic|synthetic_network|network_count|offsite_count|tasks_public_ip|db_[a-z_]+|kms_deletion_days|secret_recovery_days|cognito_protection|audit_lock_days)\b/;

/**
 * Every place the rest of the root consults the profile: file -> { whitespace-normalised line: how many times it appears }. The ratchet.
 * Counts matter: nine resources of the backups group carry `count = local.offsite_count`, and losing ONE of them (a bucket that is always
 * created) must be seen, which a set of distinct lines would not.
 */
export const EXPECTED_USES = {
  'api-compute.tf': { 'assign_public_ip = local.tasks_public_ip': 1, 'deletion_window_in_days = local.kms_deletion_days': 1, 'recovery_window_in_days = local.secret_recovery_days': 5 },
  'audit.tf': { 'days = local.audit_lock_days': 1, 'deletion_window_in_days = local.kms_deletion_days': 1, 'force_destroy = local.synthetic': 1, 'is_multi_region_trail = !local.synthetic': 1 },
  'cognito.tf': { 'deletion_protection = local.cognito_protection': 1 },
  'database.tf': {
    'backup_retention_period = local.db_backup_retention': 1,
    'count = local.offsite_count': 1,
    'deletion_protection = local.db_deletion_protection': 1,
    'final_snapshot_identifier = local.synthetic ? null : "${local.name}-final"': 1,
    'instance_class = local.db_instance_class': 1,
    'multi_az = local.db_multi_az': 1,
    'performance_insights_enabled = local.db_performance_insights': 1,
    'performance_insights_kms_key_id = local.db_performance_insights ? aws_kms_key.data.arn : null': 1,
    'performance_insights_retention_period = local.db_performance_insights ? 7 : null': 1,
    'skip_final_snapshot = local.synthetic': 1,
  },
  'iam.tf': { 'count = local.offsite_count': 2 },
  'kms.tf': { 'count = local.offsite_count': 2, 'deletion_window_in_days = local.kms_deletion_days': 2 },
  'outputs.tf': { 'value = local.synthetic ? null : aws_iam_policy.backup_job[0].arn': 1, 'value = local.synthetic ? null : aws_kms_key.backup[0].arn': 1, 'value = local.synthetic ? null : aws_s3_bucket.backups[0].bucket': 1 },
  'registry.tf': { 'force_delete = local.synthetic': 1 },
  'storage.tf': { 'count = local.offsite_count': 9, 'force_destroy = local.synthetic': 2 },
  'worker.tf': { 'assign_public_ip = local.tasks_public_ip': 1, 'deletion_window_in_days = local.kms_deletion_days': 1, 'recovery_window_in_days = local.secret_recovery_days': 1 },
};

/** The definitions in profile.tf. In the production branch of every one of them the value is the variable, unchanged. */
const PROFILE_LINES = [
  'synthetic = var.deployment_profile == "synthetic"',
  'offsite_count = local.synthetic ? 0 : 1',
  'synthetic_network = local.synthetic && var.vpc_id == ""',
  'network_count = local.synthetic_network ? 1 : 0',
  'vpc_id = local.synthetic_network ? aws_vpc.synthetic[0].id : var.vpc_id',
  'data_subnet_ids = local.synthetic_network ? aws_subnet.synthetic[*].id : var.private_subnet_ids',
  'alb_subnet_ids = local.synthetic_network ? aws_subnet.synthetic[*].id : var.public_subnet_ids',
  'tasks_public_ip = local.synthetic_network',
  'db_instance_class = local.synthetic ? "db.t4g.micro" : var.db_instance_class',
  'db_multi_az = local.synthetic ? false : var.db_multi_az',
  'db_deletion_protection = local.synthetic ? false : var.db_deletion_protection',
  'db_backup_retention = local.synthetic ? 1 : var.db_backup_retention_days',
  'db_performance_insights = !local.synthetic',
  'kms_deletion_days = local.synthetic ? 7 : 30',
  'secret_recovery_days = local.synthetic ? 0 : 30',
  'cognito_protection = local.synthetic ? "INACTIVE" : var.cognito_deletion_protection',
  'audit_lock_days = local.synthetic ? 1 : var.audit_lock_days',
];

/** The refusals, as they must read in the check resource. */
const REFUSALS = [
  'condition = !local.synthetic || var.environment == "staging"',
  'condition = var.environment != "production" || var.deployment_profile == "production"',
  'condition = local.vpc_id != ""',
  'condition = length(local.data_subnet_ids) >= 2',
  'condition = !local.synthetic || (var.audit_lock_mode == "GOVERNANCE" && var.backup_lock_mode == "GOVERNANCE")',
];

/** Written in place, these make the profile irrelevant: a relaxation that does not go through the profile locals. */
const LITERAL_RELAXATIONS = [
  [/force_destroy\s*=\s*true/, 'a bucket made force-destroyable by a literal'],
  [/force_delete\s*=\s*true/, 'a repository made force-deletable by a literal'],
  [/skip_final_snapshot\s*=\s*true/, 'the final snapshot skipped by a literal'],
  [/deletion_protection\s*=\s*(false|"INACTIVE")/, 'deletion protection removed by a literal'],
  [/recovery_window_in_days\s*=\s*0\b/, 'a secret deleted at once by a literal'],
  [/assign_public_ip\s*=\s*true/, 'tasks given a public address by a literal'],
  [/is_multi_region_trail\s*=\s*false/, 'the trail made single-Region by a literal'],
  [/multi_az\s*=\s*false/, 'Multi-AZ removed by a literal'],
];

/** What is wrong with the Terraform files `files` (name -> text), as a list of sentences. */
export function profileProblems(files) {
  const problems = [];
  const need = (condition, why) => {
    if (!condition) problems.push(why);
  };
  const profile = code(files['profile.tf'] ?? '');
  const network = code(files['network-synthetic.tf'] ?? '');
  const lines = (text) => text.split('\n').map(squash).filter(Boolean);
  const profileLines = new Set(lines(profile));

  // The default is production: a forgotten variable can never select the relaxed profile.
  const [variable] = blocks(profile, 'variable "deployment_profile"');
  need(variable !== undefined && /default\s*=\s*"production"/.test(variable), 'deployment_profile must default to "production"');
  need(variable !== undefined && squash(variable).includes('contains(["production", "synthetic"], var.deployment_profile)'), 'deployment_profile must accept only production and synthetic');

  // Each local is defined as the production value (the variable) unless the profile is synthetic.
  for (const line of PROFILE_LINES) need(profileLines.has(squash(line)), `profile.tf must define: ${line}`);

  // The refusals.
  const [check] = blocks(profile, 'resource "terraform_data" "profile"');
  need(check !== undefined, 'the profile check (terraform_data.profile) must exist');
  const checkLines = new Set(lines(check ?? ''));
  for (const line of REFUSALS) need(checkLines.has(squash(line)), `the profile check must refuse: ${line}`);

  // Nothing outside the defining files reads the profile variable (outputs.tf reports it and versions.tf tags with it); everything else goes through the locals.
  for (const [name, text] of Object.entries(files)) {
    if (DEFINING.has(name)) continue;
    const body = code(text);
    if (!REPORTS_PROFILE.has(name)) need(!/var\.deployment_profile/.test(body), `${name} must not read var.deployment_profile: use the locals in profile.tf`);
    for (const [pattern, what] of LITERAL_RELAXATIONS) need(!pattern.test(body), `${name}: ${what} (it must go through the profile locals)`);
  }

  // The ratchet: the places the root consults the profile are exactly the expected ones, each the expected number of times.
  const found = {};
  for (const [name, text] of Object.entries(files)) {
    if (DEFINING.has(name)) continue;
    for (const line of lines(code(text)).filter((l) => RELAXING.test(l))) {
      found[name] ??= {};
      found[name][line] = (found[name][line] ?? 0) + 1;
    }
  }
  for (const name of new Set([...Object.keys(found), ...Object.keys(EXPECTED_USES)])) {
    const got = found[name] ?? {};
    const want = Object.fromEntries(Object.entries(EXPECTED_USES[name] ?? {}).map(([line, n]) => [squash(line), n]));
    for (const line of new Set([...Object.keys(got), ...Object.keys(want)])) {
      need(
        (got[line] ?? 0) === (want[line] ?? 0),
        `${name} consults the profile ${got[line] ?? 0} time(s) where this guard lists ${want[line] ?? 0} (add a new use to EXPECTED_USES only after deciding it is safe): ${line}`,
      );
    }
  }

  // The synthetic network: no NAT gateway (it costs every hour), the account's default VPC is never used, and the default group stays closed.
  const everything = Object.values(files).map(code).join('\n');
  need(!/aws_nat_gateway|aws_eip\b/.test(everything), 'no NAT gateway or Elastic IP: the synthetic profile uses public subnets');
  need(!/aws_default_vpc|aws_default_subnet/.test(everything), "the account's default VPC cannot be destroyed cleanly: create the network instead");
  const [defaultGroup] = blocks(network, 'resource "aws_default_security_group" "synthetic"');
  need(defaultGroup !== undefined && !/\b(ingress|egress)\b/.test(defaultGroup), "the synthetic VPC's default security group must admit and send nothing");
  need(/map_public_ip_on_launch\s*=\s*false/.test(network), 'subnets must not hand out public addresses on their own (the tasks ask explicitly)');
  need(!/cidr_blocks|cidr_ipv4\s*=\s*"0\.0\.0\.0\/0"/.test(network.replace(/destination_cidr_block\s*=\s*"0\.0\.0\.0\/0"/, '')), 'network-synthetic.tf may route to the internet but must not open any ingress to it');
  return problems;
}

const files = Object.fromEntries(readdirSync(dir).filter((name) => name.endsWith('.tf')).map((name) => [name, read(name)]));

test('the deployment profile text has no problems (and the scan found the files: a floor, so an empty read cannot pass)', () => {
  assert.ok(Object.keys(files).length >= 14, 'expected the whole Terraform root');
  assert.ok(files['profile.tf'] && files['network-synthetic.tf'], 'the profile files must exist');
  assert.deepEqual(profileProblems(files), []);
});

test('the profile guard reports each way the profile could be weakened (controls)', () => {
  const edit = (name, from, to) => {
    assert.ok(files[name].includes(from), `the control must match the real text of ${name}: ${from}`);
    return { ...files, [name]: files[name].replace(from, to) };
  };
  const append = (name, extra) => ({ ...files, [name]: `${files[name]}\n${extra}\n` });
  const weakened = [
    ['the default becomes synthetic', edit('profile.tf', 'default     = "production"', 'default     = "synthetic"')],
    ['a third profile name is accepted', edit('profile.tf', 'contains(["production", "synthetic"], var.deployment_profile)', 'contains(["production", "synthetic", "demo"], var.deployment_profile)')],
    ['the synthetic switch is inverted', edit('profile.tf', 'synthetic = var.deployment_profile == "synthetic"', 'synthetic = var.deployment_profile != "synthetic"')],
    ['production database loses its variable', edit('profile.tf', ': var.db_deletion_protection', ': false')],
    ['production keeps one day of recovery', edit('profile.tf', ': var.db_backup_retention_days', ': 1')],
    ['production keys get the short window', edit('profile.tf', 'local.synthetic ? 7 : 30', 'local.synthetic ? 7 : 7')],
    ['the staging-only refusal is removed', edit('profile.tf', '!local.synthetic || var.environment == "staging"', 'true')],
    ['the production-environment refusal is removed', edit('profile.tf', 'var.environment != "production" || var.deployment_profile == "production"', 'true')],
    ['the network refusal is removed', edit('profile.tf', 'length(local.data_subnet_ids) >= 2', 'true')],
    ['the COMPLIANCE-lock refusal is removed', edit('profile.tf', '(var.audit_lock_mode == "GOVERNANCE" && var.backup_lock_mode == "GOVERNANCE")', 'true')],
    ['a bucket force-destroyable by a literal', edit('storage.tf', 'resource "aws_s3_bucket" "reports" {\n  bucket        = "${local.name}-reports-${data.aws_caller_identity.current.account_id}"\n  force_destroy = local.synthetic', 'resource "aws_s3_bucket" "reports" {\n  bucket        = "${local.name}-reports-${data.aws_caller_identity.current.account_id}"\n  force_destroy = true')],
    ['a repository force-deletable by a literal', edit('registry.tf', 'force_delete = local.synthetic', 'force_delete = true')],
    ['the backups bucket always created', edit('storage.tf', 'resource "aws_s3_bucket" "backups" {\n  count               = local.offsite_count\n', 'resource "aws_s3_bucket" "backups" {\n')],
    ['the replication always created', edit('database.tf', 'resource "aws_db_instance_automated_backups_replication" "offsite" {\n  count                  = local.offsite_count\n', 'resource "aws_db_instance_automated_backups_replication" "offsite" {\n')],
    ['the trail single-Region by a literal', edit('audit.tf', 'is_multi_region_trail         = !local.synthetic', 'is_multi_region_trail         = false')],
    ['production tasks given a public address', edit('api-compute.tf', 'assign_public_ip = local.tasks_public_ip', 'assign_public_ip = true')],
    ['the database deletion protection follows the profile directly', edit('database.tf', 'deletion_protection       = local.db_deletion_protection', 'deletion_protection       = !local.synthetic')],
    ['a new relaxation nobody listed', append('cognito.tf', 'resource "terraform_data" "extra" {\n  input = local.synthetic ? "a" : "b"\n}')],
    ['another file reads the profile variable', append('kms.tf', 'locals {\n  x = var.deployment_profile\n}')],
    ['a NAT gateway', append('network-synthetic.tf', 'resource "aws_nat_gateway" "x" {\n  subnet_id = "s"\n}')],
    ["the account's default VPC", append('network-synthetic.tf', 'resource "aws_default_vpc" "x" {}')],
    ['the default security group opens up', edit('network-synthetic.tf', 'resource "aws_default_security_group" "synthetic" {\n  count  = local.network_count\n  vpc_id = aws_vpc.synthetic[0].id\n', 'resource "aws_default_security_group" "synthetic" {\n  count  = local.network_count\n  vpc_id = aws_vpc.synthetic[0].id\n  ingress {\n    self = true\n  }\n')],
    ['subnets hand out public addresses', edit('network-synthetic.tf', 'map_public_ip_on_launch = false', 'map_public_ip_on_launch = true')],
    ['the synthetic network opens ingress to the internet', append('network-synthetic.tf', 'resource "aws_security_group" "x" {\n  ingress {\n    cidr_blocks = ["0.0.0.0/0"]\n  }\n}')],
    ['a profile use removed', edit('kms.tf', '  deletion_window_in_days = local.kms_deletion_days\n}\n\nresource "aws_kms_alias" "data"', '  deletion_window_in_days = 30\n}\n\nresource "aws_kms_alias" "data"')],
  ];
  for (const [name, broken] of weakened) assert.ok(profileProblems(broken).length > 0, `a weakened text must be reported: ${name}`);
  assert.deepEqual(profileProblems(files), []); // control: the unchanged text is clean
});
