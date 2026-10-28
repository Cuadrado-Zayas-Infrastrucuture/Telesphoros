// Guards for the database connection budget (database-connections.tf). Imported by guard.test.mjs, so `pnpm test:infra` runs it.
// The budget is only as good as the pool sizes it adds up, and those live in code: this keeps the Terraform numbers in agreement with the
// code that opens the pools, the estimates in agreement with AWS's formula, and the refusals in place. `connectionProblems` returns what is
// wrong with copies of the texts; the tests run it on the real files and on broken copies, so every rule has been seen to fail.
// It reads TEXT: the arithmetic and the refusals themselves are planned by the runs in profiles.tftest.hcl.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const real = {
  connections: read('./database-connections.tf'),
  database: read('./database.tf'),
  api: read('./api-compute.tf'),
  worker: read('./worker.tf'),
  env: read('../../apps/backend/src/config/env.ts'),
  verifier: read('../../apps/backend/src/ledger/verifier.ts'),
  workerMain: read('../../apps/worker/src/main.ts'),
  issuerCore: read('../../apps/backend/src/issuer/issuer-core.ts'),
  issuerApp: read('../../apps/backend/src/issuer/issuer-app.ts'),
  issuer: read('./issuer.tf'),
  provisionLogins: read('../../apps/backend/src/db/provision-logins.ts'),
};

const squash = (s) => s.replace(/\s+/g, ' ');
const code = (text) => text.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
const GIB = 1024 ** 3;

export function connectionProblems(t = real) {
  const problems = [];
  const need = (ok, message) => {
    if (!ok) problems.push(message);
  };
  const tf = squash(code(t.connections));

  // The pool sizes the sum uses are the ones the code opens.
  need(/DATABASE_POOL_MAX: z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\(50\)\.default\(10\)/.test(t.env), 'the backend DATABASE_POOL_MAX must be 1 to 50, default 10');
  need(/variable "api_db_pool_max" \{[^}]*default = 10\b/.test(tf), 'api_db_pool_max must default to the backend default, 10');
  need(/var\.api_db_pool_max >= 1 && var\.api_db_pool_max <= 50/.test(tf), 'api_db_pool_max must have the backend bounds, 1 to 50');
  const verifierMax = /\bmax: (\d+),/.exec(t.verifier)?.[1];
  need(verifierMax !== undefined && tf.includes(`(var.api_db_pool_max + ${verifierMax})`), 'each API task must count the ledger verifier pool the code opens');
  const workerExtra = /max: config\.concurrency \+ (\d+)/.exec(t.workerMain)?.[1];
  need(workerExtra !== undefined && tf.includes(`(local.worker_concurrency + ${workerExtra})`), 'each worker task must count WORKER_CONCURRENCY plus the extra connections the worker opens');
  const issuerMax = /max: options\.max \?\? (\d+),/.exec(t.issuerCore)?.[1];
  need(!/new PgCapabilityIssueStore\(\{[^}]*\bmax:/.test(t.issuerApp), 'the issuer service must use the store default pool size (or the budget must read its setting)');
  need(issuerMax !== undefined && tf.includes(`var.issuer_desired_count * ${issuerMax}`), 'each issuer task must count the pool the issuer store opens');
  need(/local\.api_service_count \* 1\b/.test(tf), 'the migration task must be counted');

  // A deploy starts the new tasks before it stops the old ones, so each service peaks at deployment_maximum_percent of its count.
  const peak = /connection_deploy_peak_percent = (\d+)\b/.exec(tf)?.[1];
  need(peak !== undefined, 'the deploy peak percent must be stated');
  for (const [key, service] of [['api', 'api'], ['worker', 'worker'], ['issuer', 'issuer']]) {
    const percent = new RegExp(`resource "aws_ecs_service" "${service}" \\{[\\s\\S]*?deployment_maximum_percent\\s*=\\s*(\\d+)`).exec(code(t[key]))?.[1];
    need(percent !== undefined && percent === peak, `the ${service} service's deployment_maximum_percent must equal connection_deploy_peak_percent`);
  }
  need(/ceil\(\( local\.api_service_count \* var\.api_desired_count [^)]*\)[\s\S]*\) \* local\.connection_deploy_peak_percent \/ 100\) \+ local\.api_service_count \* 1 \)/.test(tf), 'the services must be counted at their deploy peak (the migration task once)');
  need(/WORKER_CONCURRENCY\s*=\s*tostring\(local\.worker_concurrency\)/.test(t.worker), 'the worker task must take WORKER_CONCURRENCY from local.worker_concurrency');
  need(/DATABASE_POOL_MAX\s*=\s*tostring\(var\.api_db_pool_max\)/.test(t.api), 'the API task must take DATABASE_POOL_MAX from api_db_pool_max');

  // Each login's own CONNECTION LIMIT (provision-logins.ts sets it) must hold that login's connections at the deploy peak.
  const codeLimits = Object.fromEntries([...t.provisionLogins.matchAll(/^\s*(\w+): \{ settings: \{[^}]*\}, connectionLimit: (\d+) \},?$/gm)].map(([, kind, limit]) => [kind, limit]));
  const tfLimits = Object.fromEntries([...(/login_connection_limits = \{([^}]*)\}/.exec(tf)?.[1] ?? '').matchAll(/(\w+) = (\d+)/g)].map(([, kind, limit]) => [kind, limit]));
  need(Object.keys(codeLimits).length >= 5, 'the scan must find the login limits in provision-logins.ts');
  const sorted = (o) => JSON.stringify(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
  need(sorted(tfLimits) === sorted(codeLimits), `login_connection_limits must equal LOGIN_LIMITS in provision-logins.ts (${JSON.stringify(codeLimits)})`);
  const peakOf = (expression) => `ceil(${expression} * local.connection_deploy_peak_percent / 100)`;
  need(tf.includes(`app = ${peakOf('local.api_service_count * var.api_desired_count * var.api_db_pool_max')}`), 'the app login must count every API task\'s pool at the deploy peak');
  need(verifierMax !== undefined && tf.includes(`verifier = ${peakOf(`local.api_service_count * var.api_desired_count * ${verifierMax}`)}`), 'the verifier login must count every API task\'s verifier pool at the deploy peak');
  need(workerExtra !== undefined && tf.includes(`worker = ${peakOf(`local.api_service_count * var.worker_desired_count * (local.worker_concurrency + ${workerExtra})`)}`), 'the worker login must count every worker\'s pool at the deploy peak');
  need(issuerMax !== undefined && tf.includes(`issuer = ${peakOf(`local.issuer_service_count * var.issuer_desired_count * ${issuerMax}`)}`), 'the issuer login must count every issuer\'s pool at the deploy peak');
  need(tf.includes('migrator = local.api_service_count * 1'), 'the migrator login must count the migration task');
  need(tf.includes('logins_over_limit = [for login, demand in local.login_connection_demand : login if demand > local.login_connection_limits[login]]'), 'the logins over their limit must be computed from the demand and the limits');

  // The estimates follow the formula the file states, and are labelled as estimates.
  need(/ESTIMATES, NOT READINGS/.test(t.connections), 'the estimates must be labelled as estimates');
  const table = /connection_estimates = \{([^}]*)\}/.exec(tf)?.[1] ?? '';
  const entries = [...table.matchAll(/"(db\.t4g\.(\w+))" = (\d+)/g)];
  need(entries.length >= 2, 'the estimates table must list the classes in use');
  const memory = { micro: 1, small: 2, medium: 4, large: 8 };
  for (const [, cls, size, value] of entries) {
    const expected = Math.floor(((memory[size] ?? NaN) * GIB) / 9531392 * 0.65) - 5;
    need(Number(value) === expected, `${cls}: the estimate must be floor(listed bytes / 9531392 x 0.65) - 5 = ${expected}`);
  }

  // The refusals.
  const db = squash(code(t.database));
  need(db.includes('condition = var.environment != "production" || var.db_connection_budget != null'), 'production must refuse an estimated budget');
  need(db.includes('condition = local.connection_budget != null'), 'a class with no estimate must need a reading');
  need(db.includes('condition = local.connection_budget == null || local.connection_demand <= coalesce(local.connection_budget, 0)'), 'the demand must be refused above the budget');
  need(db.includes('condition = length(local.logins_over_limit) == 0'), 'a login over its own connection limit must be refused');
  return problems;
}

test('the connection budget text has no problems (and the scan found the files)', () => {
  assert.ok(real.connections.length > 500 && real.verifier.includes('max:') && real.workerMain.includes('concurrency'));
  assert.deepEqual(connectionProblems(), []);
});

test('the connection budget guard reports each way the texts could drift (controls)', () => {
  const broken = (key, from, to) => {
    assert.ok(real[key].includes(from), `the control's text must exist: ${from}`);
    return connectionProblems({ ...real, [key]: real[key].replace(from, to) });
  };
  const cases = [
    ['verifier', 'max: 3,', 'max: 4,', 'ledger verifier'],
    ['workerMain', 'max: config.concurrency + 3', 'max: config.concurrency + 5', 'WORKER_CONCURRENCY plus'],
    ['issuerCore', 'max: options.max ?? 4,', 'max: options.max ?? 6,', 'issuer store opens'],
    ['env', '.default(10)', '.default(20)', 'backend DATABASE_POOL_MAX'],
    ['worker', 'tostring(local.worker_concurrency)', '"4"', 'local.worker_concurrency'],
    ['api', 'DATABASE_POOL_MAX                 = tostring(var.api_db_pool_max)', '', 'api_db_pool_max'],
    ['connections', '"db.t4g.small"  = 141', '"db.t4g.small"  = 160', 'db.t4g.small'],
    ['connections', 'ESTIMATES, NOT READINGS', 'Defaults', 'labelled as estimates'],
    ['database', 'var.environment != "production" || var.db_connection_budget != null', 'true', 'production must refuse'],
    ['database', 'local.connection_demand <= coalesce(local.connection_budget, 0)', 'true', 'refused above the budget'],
    ['worker', 'deployment_maximum_percent         = 200', 'deployment_maximum_percent         = 300', "worker service's deployment_maximum_percent"],
    ['issuer', 'deployment_maximum_percent         = 200', 'deployment_maximum_percent         = 150', "issuer service's deployment_maximum_percent"],
    ['api', 'deployment_maximum_percent         = 200', 'deployment_maximum_percent         = 250', "api service's deployment_maximum_percent"],
    ['connections', ') * local.connection_deploy_peak_percent / 100)', '))', 'deploy peak'],
    ['provisionLogins', "lock_timeout: '5s' }, connectionLimit: 20 },\n  migrator", "lock_timeout: '5s' }, connectionLimit: 25 },\n  migrator", 'LOGIN_LIMITS'],
    ['connections', 'verifier = 20', 'verifier = 30', 'LOGIN_LIMITS'],
    ['connections', 'var.api_desired_count * 3 * local', 'var.api_desired_count * 2 * local', 'verifier login'],
    ['connections', 'var.api_desired_count * var.api_db_pool_max * local', 'var.api_db_pool_max * local', 'app login'],
    ['connections', 'if demand > local.login_connection_limits[login]', 'if demand > 9999', 'logins over their limit'],
    ['database', 'condition     = length(local.logins_over_limit) == 0', 'condition     = true', 'own connection limit'],
  ];
  for (const [key, from, to, expected] of cases) {
    const problems = broken(key, from, to);
    assert.ok(problems.some((p) => p.includes(expected)), `${key}: "${from}" -> "${to}" must report "${expected}", got ${JSON.stringify(problems)}`);
  }
});
