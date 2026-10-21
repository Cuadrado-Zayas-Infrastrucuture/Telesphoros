// Tests for scripts/staging/run-task.sh (FD-7 slice 3). Imported by infrastructure/terraform/guard.test.mjs, so `pnpm test:infra` runs it.
// The script is run for real with a stand-in `aws` that records every argument it receives (one per line), so the exact command, the exact overrides
// and the order of calls are checked. What this cannot prove: that ECS accepts these arguments, that the tasks start, or what the database does.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const root = new URL('../../', import.meta.url).pathname;
const script = join(root, 'scripts/staging/run-task.sh');
const read = (path) => readFileSync(join(root, path), 'utf8');
const sandbox = mkdtempSync(join(tmpdir(), 'run-task-'));
after(() => rmSync(sandbox, { recursive: true, force: true }));

const ENV = {
  AWS_REGION: 'us-east-2',
  ECS_CLUSTER: 'telesphoros-staging-api',
  MIGRATE_TASK_FAMILY: 'telesphoros-staging-api-migrate',
  PROVISION_TASK_FAMILY: 'telesphoros-staging-api-provision',
  TASK_SUBNETS: 'subnet-0a1b2c3d,subnet-4e5f6a7b',
  TASK_SECURITY_GROUP: 'sg-0123abcd',
  TASK_ASSIGN_PUBLIC_IP: 'true',
  API_LOG_GROUP: '/ecs/telesphoros-staging-api',
};
const TASK_ID = 'a'.repeat(32);
const TASK_ARN = `arn:aws:ecs:us-east-2:123456789012:task/telesphoros-staging-api/${TASK_ID}`;

/** A stand-in `aws`: writes "CALL" then each argument on its own line to $STUB_LOG, and answers the few queries the script makes from STUB_* variables. */
function stubDir() {
  const dir = mkdtempSync(join(sandbox, 'stub-'));
  writeFileSync(
    join(dir, 'aws'),
    `#!/usr/bin/env bash
{ echo CALL; for a in "$@"; do echo "ARG:$a"; done; } >> "$STUB_LOG"
case "$1 $2" in
  "ecs run-task") echo "\${STUB_TASK_ARN-}" ;;
  "ecs wait") exit "\${STUB_WAIT_STATUS:-0}" ;;
  "ecs describe-tasks")
    case "$*" in *exitCode*) echo "\${STUB_EXIT:-0}" ;; *stoppedReason*) echo "\${STUB_REASON:-Essential container in task exited}" ;; esac ;;
  "logs get-log-events") echo "\${STUB_LOG_TEXT:-log line}"; exit "\${STUB_LOGS_STATUS:-0}" ;;
  "sts get-caller-identity") echo "123456789012 arn:aws:iam::123456789012:user/tester" ;;
esac
exit 0
`,
  );
  chmodSync(join(dir, 'aws'), 0o755);
  return dir;
}

/** Runs the script. `env` entries set to undefined are removed. */
function run(argv, { env = {}, stub = {} } = {}) {
  const dir = stubDir();
  const log = join(dir, 'calls.log');
  const full = { PATH: `${dir}:${process.env.PATH}`, HOME: sandbox, STUB_LOG: log, STUB_TASK_ARN: TASK_ARN, LOG_DELAY_SECONDS: '0', ...ENV, ...env, ...stub };
  for (const [k, v] of Object.entries(full)) if (v === undefined) delete full[k];
  const result = spawnSync('bash', [script, ...argv], { encoding: 'utf8', env: full, cwd: sandbox });
  const raw = existsSync(log) ? readFileSync(log, 'utf8') : '';
  const calls = raw
    .split('CALL\n')
    .filter(Boolean)
    .map((chunk) => chunk.split('\n').filter((l) => l.startsWith('ARG:')).map((l) => l.slice(4)));
  return { status: result.status, out: `${result.stdout}${result.stderr}`, calls };
}

const find = (calls, a, b) => calls.filter((c) => c[0] === a && c[1] === b);
const after_ = (call, flag) => call[call.indexOf(flag) + 1];

/** The run-task call of a --yes run, decoded. */
function started(argv, options) {
  const result = run([...argv, '--yes'], options);
  assert.equal(result.status, 0, result.out);
  const [call] = find(result.calls, 'ecs', 'run-task');
  assert.ok(call, 'a run-task call was made');
  return { call, overrides: JSON.parse(after_(call, '--overrides')), result };
}

test('the default is a dry run: it validates, prints the command and the override, and calls aws not at all', () => {
  const { status, out, calls } = run(['tenant-create', '--id', 'pilot-clinic', '--name', 'Pilot Clinic', '--by', 'jan']);
  assert.equal(status, 0, out);
  assert.match(out, /dry run: nothing started/);
  assert.match(out, /command override: \{"containerOverrides":\[\{"name":"migrate","command":\["dist\/db\/cli\.js","tenant","create"/);
  assert.deepEqual(calls, [], 'a dry run must not call aws');
});

test('each step runs the right task, container and command', () => {
  const cases = [
    [['provision-logins'], 'PROVISION', 'provision', ['provision-logins']],
    [['provision-logins', '--rotate'], 'PROVISION', 'provision', ['provision-logins', '--rotate']],
    [['provision-logins', '--require-migrated'], 'PROVISION', 'provision', ['provision-logins', '--require-migrated']],
    [['migrate-up'], 'MIGRATE', 'migrate', ['migrate', 'up']],
    [['migrate-status'], 'MIGRATE', 'migrate', ['migrate', 'status']],
    [['tenant-list'], 'MIGRATE', 'migrate', ['tenant', 'list']],
    [['tenant-create', '--id', 'pilot-clinic', '--name', 'Pilot Clinic', '--by', 'Jan Z'], 'MIGRATE', 'migrate', ['tenant', 'create', '--id', 'pilot-clinic', '--name', 'Pilot Clinic', '--by', 'Jan Z']],
    [['membership-grant', '--tenant', 'pilot-clinic', '--sub', '11111111-2222-3333-4444-555555555555', '--roles', 'admin,clinician', '--by', 'jan'], 'MIGRATE', 'migrate', ['membership', 'grant', '--tenant', 'pilot-clinic', '--sub', '11111111-2222-3333-4444-555555555555', '--roles', 'admin,clinician', '--by', 'jan']],
    [['membership-grant', '--tenant', 'pilot-clinic', '--sub', 'abc', '--roles', 'reader', '--by', 'jan', '--reason', 'first administrator'], 'MIGRATE', 'migrate', ['membership', 'grant', '--tenant', 'pilot-clinic', '--sub', 'abc', '--roles', 'reader', '--by', 'jan', '--reason', 'first administrator']],
    [['membership-show', '--tenant', 'pilot-clinic', '--sub', 'abc'], 'MIGRATE', 'migrate', ['membership', 'show', '--tenant', 'pilot-clinic', '--sub', 'abc']],
  ];
  for (const [argv, which, container, command] of cases) {
    const { call, overrides } = started(argv);
    assert.equal(after_(call, '--task-definition'), ENV[`${which}_TASK_FAMILY`], argv.join(' '));
    assert.equal(after_(call, '--cluster'), ENV.ECS_CLUSTER);
    assert.equal(after_(call, '--launch-type'), 'FARGATE');
    assert.equal(after_(call, '--count'), '1');
    assert.deepEqual(overrides, { containerOverrides: [{ name: container, command: ['dist/db/cli.js', ...command] }] }, argv.join(' '));
  }
});

test('the network comes from the environment, and a public address is asked for only when told to', () => {
  const on = started(['migrate-status']);
  assert.equal(after_(on.call, '--network-configuration'), 'awsvpcConfiguration={subnets=[subnet-0a1b2c3d,subnet-4e5f6a7b],securityGroups=[sg-0123abcd],assignPublicIp=ENABLED}');
  const off = started(['migrate-status'], { env: { TASK_ASSIGN_PUBLIC_IP: 'false' } });
  assert.match(after_(off.call, '--network-configuration'), /assignPublicIp=DISABLED\}$/);
  assert.equal(after_(off.call, '--region'), 'us-east-2');
});

test('free text is passed as data: quotes, $(...), semicolons and spaces arrive unchanged and nothing is executed', () => {
  const canary = join(sandbox, 'canary');
  // A relative canary keeps the payload within the real 120-character name limit even on macOS's long temporary paths.
  const name = 'Pilot "Clinic" $(touch canary); `touch canary` & more';
  assert.ok(name.length <= 120);
  const { overrides } = started(['tenant-create', '--id', 'pilot-clinic', '--name', name, '--by', "O'Brien; rm -rf /"]);
  assert.deepEqual(overrides.containerOverrides[0].command.slice(-4), ['--name', name, '--by', "O'Brien; rm -rf /"]);
  assert.equal(existsSync(canary), false, 'a value was interpreted by a shell');
});

test('every refusal happens before anything is started', () => {
  const grant = (over = {}) => {
    const f = { tenant: 'pilot-clinic', sub: 'abc', roles: 'admin', by: 'jan', ...over };
    return ['membership-grant', ...Object.entries(f).flatMap(([k, v]) => (v === undefined ? [] : [`--${k}`, v]))];
  };
  const bad = [
    ['no step', [], /a step is required/],
    ['only the confirmation flag', ['--yes'], /a step is required/],
    ['an unknown step', ['migrate-down'], /unknown step/],
    ['a destructive step is not offered', ['membership-remove', '--tenant', 'a', '--sub', 'b', '--by', 'c'], /unknown step/],
    ['an uppercase organization id', grant({ tenant: 'Pilot' }), /organization id/],
    ['an organization id starting with a dash', grant({ tenant: '-pilot' }), /organization id/],
    ['an organization id of 64 characters', grant({ tenant: 'a'.repeat(64) }), /organization id/],
    ['an organization id with a space', grant({ tenant: 'pilot clinic' }), /organization id/],
    ['a system actor as the person', grant({ sub: 'system:jobs' }), /subject id/],
    ['a sub with a semicolon', grant({ sub: 'a;b' }), /subject id/],
    ['a sub of 129 characters', grant({ sub: 'a'.repeat(129) }), /subject id/],
    ['an unknown role', grant({ roles: 'admin,root' }), /roles must be/],
    ['an empty role in the list', grant({ roles: 'admin,' }), /roles must be/],
    ['an uppercase role', grant({ roles: 'Admin' }), /roles must be/],
    ['a missing role list', grant({ roles: undefined }), /--roles is required/],
    ['a missing person', grant({ by: undefined }), /--by is required/],
    ['a control character in the actor', grant({ by: 'ja\nn' }), /--by must be/],
    ['an actor of 129 characters', grant({ by: 'a'.repeat(129) }), /--by must be/],
    ['a reason of 501 characters', [...grant(), '--reason', 'a'.repeat(501)], /--reason must be/],
    ['an unknown flag', [...grant(), '--force', 'yes'], /unknown flag/],
    ['a repeated flag', [...grant(), '--by', 'other'], /given twice/],
    ['a flag without a value', ['membership-show', '--tenant', 'pilot-clinic', '--sub'], /needs a value/],
    ['a stray argument', ['tenant-list', 'extra'], /takes no arguments/],
    ['an unknown provisioning flag', ['provision-logins', '--drop-everything'], /unknown flag/],
    ['an organization name of 121 characters', ['tenant-create', '--id', 'a', '--name', 'n'.repeat(121), '--by', 'jan'], /--name must be/],
    ['an empty organization name', ['tenant-create', '--id', 'a', '--name', '', '--by', 'jan'], /--name must be/],
  ];
  for (const [name, argv, pattern] of bad) {
    const { status, out, calls } = run(argv.length === 0 || argv[0] === '--yes' ? argv : [...argv, '--yes']);
    assert.notEqual(status, 0, `must refuse: ${name}`);
    assert.match(out, pattern, `wrong reason for: ${name}`);
    assert.deepEqual(calls, [], `nothing may be called for: ${name}`);
  }
});

test('a missing or malformed setting is refused, and there is no default for the public address', () => {
  for (const name of Object.keys(ENV)) {
    const { status, out, calls } = run(['migrate-status', '--yes'], { env: { [name]: undefined } });
    assert.notEqual(status, 0, `${name} unset must fail`);
    assert.match(out, new RegExp(`${name} is not set`));
    assert.deepEqual(calls, []);
  }
  const bad = [
    ['a region with a space', { AWS_REGION: 'us east 2' }, /not a region/],
    ['a cluster with a slash', { ECS_CLUSTER: 'a/b' }, /not a cluster name/],
    ['a task family with a colon (a revision)', { MIGRATE_TASK_FAMILY: 'telesphoros-staging-api-migrate:3' }, /not a task family/],
    ['a subnet that is not a subnet', { TASK_SUBNETS: 'subnet-0a1b2c3d,vpc-0a1b2c3d' }, /subnet ids/],
    ['a trailing comma in the subnets', { TASK_SUBNETS: 'subnet-0a1b2c3d,' }, /subnet ids/],
    ['a security group name', { TASK_SECURITY_GROUP: 'default' }, /security group id/],
    ['a yes for the public address', { TASK_ASSIGN_PUBLIC_IP: 'yes' }, /true or false/],
    ['a log group with a space', { API_LOG_GROUP: '/ecs/a b' }, /not a log group/],
  ];
  for (const [name, env, pattern] of bad) {
    const { status, out, calls } = run(['migrate-status', '--yes'], { env });
    assert.notEqual(status, 0, `must refuse: ${name}`);
    assert.match(out, pattern, name);
    assert.deepEqual(calls, []);
  }
});

test('log group names accept the full 1 to 512 ASCII character range and reject invalid names before any AWS call', () => {
  for (const value of ['a', '/ecs/Stage_1.#-logs', 'a'.repeat(256), 'a'.repeat(512)]) {
    const result = run(['migrate-status'], { env: { API_LOG_GROUP: value } });
    assert.equal(result.status, 0, result.out);
    assert.deepEqual(result.calls, [], 'a valid name does not change the default dry run');
  }
  const longest = 'a'.repeat(512);
  const { result } = started(['migrate-status'], { env: { API_LOG_GROUP: longest } });
  assert.equal(after_(find(result.calls, 'logs', 'get-log-events')[0], '--log-group-name'), longest);

  for (const value of ['', 'a'.repeat(513), '/ecs/a b', '/ecs/a:b', '/ecs/a\nb', '/ecs/café']) {
    const result = run(['migrate-status', '--yes'], { env: { API_LOG_GROUP: value } });
    assert.notEqual(result.status, 0, `must refuse ${JSON.stringify(value)}`);
    assert.match(result.out, /API_LOG_GROUP is (?:not set|not a log group name)/);
    assert.deepEqual(result.calls, [], 'validation must finish before identity, task or log calls');
  }
});

test('--yes: identity, start, wait, exit code, stop reason, then the log of this task, and exit 0 only when the task exited 0', () => {
  const ok = run(['migrate-up', '--yes'], { stub: { STUB_LOG_TEXT: 'migrate up finished' } });
  assert.equal(ok.status, 0, ok.out);
  assert.deepEqual(
    ok.calls.map((c) => c.slice(0, 2).join(' ')),
    ['sts get-caller-identity', 'ecs run-task', 'ecs wait', 'ecs describe-tasks', 'ecs describe-tasks', 'logs get-log-events'],
  );
  const [wait] = find(ok.calls, 'ecs', 'wait');
  assert.deepEqual(wait.slice(2), ['tasks-stopped', '--region', 'us-east-2', '--cluster', ENV.ECS_CLUSTER, '--tasks', TASK_ARN]);
  const [logs] = find(ok.calls, 'logs', 'get-log-events');
  assert.equal(after_(logs, '--log-group-name'), ENV.API_LOG_GROUP);
  assert.equal(after_(logs, '--log-stream-name'), `migrate/migrate/${TASK_ID}`, 'the awslogs stream is prefix/container/task id');
  assert.match(ok.out, /migrate up finished/);
  assert.match(ok.out, /the task exited 0/);

  const provision = run(['provision-logins', '--yes']);
  assert.equal(after_(find(provision.calls, 'logs', 'get-log-events')[0], '--log-stream-name'), `provision/provision/${TASK_ID}`);

  const failed = run(['migrate-up', '--yes'], { stub: { STUB_EXIT: '1', STUB_REASON: 'Essential container in task exited' } });
  assert.notEqual(failed.status, 0);
  assert.match(failed.out, /did not succeed \(exit code: 1; stopped reason: Essential container in task exited\)/);
  assert.match(failed.out, /log line/, 'the log is printed before the failure is reported');

  const noCode = run(['migrate-up', '--yes'], { stub: { STUB_EXIT: 'None', STUB_REASON: 'CannotPullContainerError' } });
  assert.notEqual(noCode.status, 0, 'a task that never ran a container has no exit code and must not count as success');
  assert.match(noCode.out, /CannotPullContainerError/);

  const notStarted = run(['migrate-up', '--yes'], { stub: { STUB_TASK_ARN: 'None' } });
  assert.notEqual(notStarted.status, 0);
  assert.match(notStarted.out, /the task did not start/);
  assert.equal(find(notStarted.calls, 'ecs', 'wait').length, 0, 'it must not wait for a task that did not start');

  const timedOut = run(['migrate-up', '--yes'], { stub: { STUB_WAIT_STATUS: '255' } });
  assert.notEqual(timedOut.status, 0);
  assert.match(timedOut.out, /did not stop in time/);

  const noLog = run(['migrate-up', '--yes'], { stub: { STUB_LOGS_STATUS: '254' } });
  assert.equal(noLog.status, 0, 'an unreadable log does not turn a successful task into a failure');
  assert.match(noLog.out, /no log could be read/);
});

test('the script agrees with the application, the Terraform and the runbook (so a change on either side fails here)', () => {
  const text = read('scripts/staging/run-task.sh');
  // Roles and organization id: the application's own definitions.
  const appRoles = [...read('packages/shared-types/src/roles.ts').match(/export const ROLES = \[([^\]]+)\]/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const scriptRoles = text.match(/case "\$role" in ([a-z|]+)\) ;;/)[1].split('|');
  assert.deepEqual(scriptRoles.sort(), [...appRoles].sort(), 'the roles the script accepts are the roles the application knows');
  const appTenant = read('packages/shared-types/src/tenant.ts').match(/tenantIdSchema = z\.string\(\)\.regex\((\/.+?\/),\s*'/)[1];
  assert.ok(text.includes(`=~ ${appTenant.replace(/^\/|\/$/g, '')}`) || text.includes(appTenant.replace(/^\/|\/$/g, '')), `the organization id pattern is ${appTenant}`);
  // The commands exist in the CLI's own usage text.
  const cli = read('apps/backend/src/db/cli.ts') + read('apps/backend/src/membership/membership-cli.ts') + read('apps/backend/src/membership/tenant-cli.ts');
  for (const usage of ['migrate up', 'migrate status', 'provision-logins [--rotate] [--require-migrated]', 'membership grant', 'membership show', 'tenant create --id ID --name NAME --by NAME', 'tenant list']) {
    assert.ok(cli.includes(usage), `the CLI documents: ${usage}`);
  }
  // Task families, containers, log stream prefixes and outputs in Terraform.
  const compute = read('infrastructure/terraform/api-compute.tf');
  const block = (header) => compute.slice(compute.indexOf(header));
  for (const [header, container, prefix] of [['resource "aws_ecs_task_definition" "api_migrate"', 'migrate', 'migrate'], ['resource "aws_ecs_task_definition" "api_provision"', 'provision', 'provision']]) {
    const body = block(header).slice(0, block(header).indexOf('\nresource "', 10));
    assert.match(body, new RegExp(`name\\s+= "${container}"`), `${header} names its container ${container}`);
    assert.match(body, new RegExp(`"awslogs-stream-prefix" = "${prefix}"`), `${header} uses the stream prefix ${prefix}`);
    assert.match(body, /command\s+= \["dist\/db\/cli\.js"/, `${header} runs the CLI the override replaces (no leading node: the image ENTRYPOINT is node)`);
  }
  assert.match(block('resource "aws_ecs_task_definition" "api_migrate"'), /DATABASE_MIGRATOR_URL/, 'the migration task holds the table owner login the tenant and membership commands need');
  for (const output of ['api_cluster_name', 'api_migrate_task_family', 'api_provision_task_family', 'api_log_group', 'api_task_subnet_ids', 'api_task_assign_public_ip', 'api_service_name']) {
    assert.match(compute, new RegExp(`output "${output}"`), `Terraform has the output ${output}`);
  }
  assert.match(read('infrastructure/terraform/api-edge.tf'), /output "api_tasks_security_group_id"/);
  assert.match(compute, /output "api_task_subnet_ids" \{[^}]*value\s*=\s*var\.enable_api_hosting \? local\.data_subnet_ids : null/s);
  assert.match(compute, /output "api_task_assign_public_ip" \{[^}]*value\s*=\s*var\.enable_api_hosting \? local\.tasks_public_ip : null/s);
  // Portability: the founder's shell may be macOS's bash 3.2.
  assert.doesNotMatch(text.replace(/^\s*#.*$/gm, ''), /declare -A|mapfile|readarray|\$\{[A-Za-z_]+(,,|\^\^)\}|&>>|\bcoproc\b/, 'bash 4 features are not available in macOS bash 3.2');
});

test('the role cross-check would notice a role the application does not have (control)', () => {
  const text = read('scripts/staging/run-task.sh');
  const mutated = text.replace('reader|clinician|admin|reviewer', 'reader|clinician|admin|reviewer|root');
  assert.notEqual(mutated, text);
  const scriptRoles = mutated.match(/case "\$role" in ([a-z|]+) \) ;;/) ?? mutated.match(/case "\$role" in ([a-z|]+)\) ;;/);
  assert.ok(scriptRoles[1].split('|').includes('root'));
  const appRoles = [...read('packages/shared-types/src/roles.ts').match(/export const ROLES = \[([^\]]+)\]/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.notDeepEqual(scriptRoles[1].split('|').sort(), [...appRoles].sort());
  // And the script itself, mutated, really does accept the role (so the cross-check, not luck, is what holds the line).
  const broken = join(sandbox, 'run-task-broken.sh');
  writeFileSync(broken, mutated);
  const result = spawnSync('bash', [broken, 'membership-grant', '--tenant', 'a', '--sub', 'b', '--roles', 'root', '--by', 'c'], { encoding: 'utf8', env: { PATH: process.env.PATH, ...ENV } });
  assert.equal(result.status, 0, 'the mutated script accepts root in a dry run');
});
