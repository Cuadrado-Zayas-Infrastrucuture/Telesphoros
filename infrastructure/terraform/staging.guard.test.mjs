// Guards for the FD-7 staged synthetic environment's variables (synthetic-staging.tfvars.example, staging.tftest.hcl). Imported by guard.test.mjs, so `pnpm test:infra` runs it.
// Like the other guards it reads TEXT. `terraform test` (staging.tftest.hcl) is the proof of what the example plans offline; this file keeps the example and that test
// in step, keeps the example inside the staging/synthetic envelope, and checks the one coupling the module does not enforce itself (api_domain = api.<web_domain>).
// `stagingProblems` returns what is wrong with a copy of the text (empty when nothing is); the tests run it on the real files and on deliberately broken copies.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { IMAGE_POLICY_UPDATES } from '../../scripts/staging/check-plan.mjs';

const dir = new URL('./', import.meta.url);
const read = (name) => readFileSync(new URL(name, dir), 'utf8');
const example = read('synthetic-staging.tfvars.example');
const tftest = read('staging.tftest.hcl');
const webTf = read('web.tf');
const allTf = readdirSync(dir).filter((n) => n.endsWith('.tf')).map(read).join('\n');

/** `name = value` assignments (strings, lists of strings, booleans, numbers) on non-comment lines. Anything else on such a line is reported by the caller. */
export function assignments(text) {
  const values = {};
  const odd = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([a-z_0-9]+)\s*=\s*(.+)$/.exec(line);
    if (!m) {
      odd.push(line);
      continue;
    }
    try {
      values[m[1]] = JSON.parse(m[2]);
    } catch {
      odd.push(line);
    }
  }
  return { values, odd };
}

/** The first top-level `variables { ... }` block of a test file (the shared values, not a run's own). */
function sharedVariables(text) {
  const start = text.search(/^variables \{/m);
  if (start < 0) return null;
  const end = text.indexOf('\n}', start);
  return text.slice(start, end).split('\n').slice(1).join('\n');
}

const APP_HOST = (webDomain) => `app.${webDomain}`;

/** What is wrong with the example `exampleText`, as a list of sentences (`tftestText` is the offline test it must equal, `webText` the module's web.tf). */
export function stagingProblems(exampleText, tftestText = tftest, webText = webTf, tfText = allTf) {
  const problems = [];
  const need = (condition, why) => {
    if (!condition) problems.push(why);
  };
  const { values: v, odd } = assignments(exampleText);
  need(odd.length === 0, `every assignment must be a plain name = value (strings, lists of strings, booleans, numbers): ${odd.join(' | ')}`);

  // In step with the offline test: the same names with the same values.
  const shared = sharedVariables(tftestText);
  need(shared !== null, 'staging.tftest.hcl must have a top-level variables block');
  const { values: t, odd: tOdd } = assignments(shared ?? '');
  need(tOdd.length === 0, `staging.tftest.hcl variables must be plain assignments: ${tOdd.join(' | ')}`);
  need(JSON.stringify(Object.entries(v).sort()) === JSON.stringify(Object.entries(t).sort()), `the example and staging.tftest.hcl must set the same variables to the same values (example: ${JSON.stringify(v)} test: ${JSON.stringify(t)})`);

  // Only variables the module declares.
  const declared = new Set([...tfText.matchAll(/^variable "([a-z_0-9]+)"/gm)].map((m) => m[1]));
  for (const name of Object.keys(v)) need(declared.has(name), `${name} is not a variable of this module`);

  // The envelope: staging, synthetic, hosting on, no production-only or network inputs, no image, nothing irreversible.
  need(v.environment === 'staging', 'environment must be "staging"');
  need(v.deployment_profile === 'synthetic', 'deployment_profile must be "synthetic"');
  need(v.enable_web_hosting === true && v.enable_api_hosting === true, 'both hosting switches are on in the example (plan A turns web off on the command line)');
  for (const name of ['vpc_id', 'private_subnet_ids', 'public_subnet_ids', 'app_security_group_ids']) need(!(name in v), `${name} must not be set: the synthetic profile creates the network`);
  for (const name of ['api_image', 'db_multi_az', 'db_deletion_protection', 'cognito_deletion_protection', 'backup_lock_mode', 'backup_lock_days', 'audit_lock_days']) need(!(name in v), `${name} must be left at its default (the profile decides, or it belongs to production or to a later step)`);
  need(!('audit_lock_mode' in v) || v.audit_lock_mode === 'GOVERNANCE', 'a COMPLIANCE lock is irreversible and the synthetic profile refuses it');
  need(!('region' in v) && !('backup_region' in v), 'region is decision D1: it stays at the default until the founder confirms it');

  // Hostnames: web_domain is a base domain; api_domain is not derived from it (the page's policy allows api.<web_domain>), so they must agree.
  need(typeof v.web_domain === 'string' && /^staging\.[a-z0-9.-]+$/.test(v.web_domain), 'web_domain must be a staging base domain (decision D3: staging.<domain>)');
  need(v.api_domain === `api.${v.web_domain}`, `api_domain must be api.<web_domain> (the web page's policy allows exactly that host): found ${v.api_domain}`);
  need(/\bweb_api\s*=\s*"https:\/\/api\.\$\{var\.web_domain\}"/.test(webText), 'web.tf must still allow api.<web_domain> in the page policy (this guard assumes it)');
  need(/\bweb_app\s*=\s*"app\.\$\{var\.web_domain\}"/.test(webText), 'web.tf must still serve the app at app.<web_domain>');

  // The module's own precondition for web hosting, and every origin https.
  const app = `https://${APP_HOST(v.web_domain)}`;
  need(Array.isArray(v.app_callback_urls) && v.app_callback_urls.includes(`${app}/auth/callback`), `app_callback_urls must contain ${app}/auth/callback`);
  need(Array.isArray(v.app_logout_urls) && v.app_logout_urls.includes(`${app}/signed-out`), `app_logout_urls must contain ${app}/signed-out`);
  need(Array.isArray(v.reports_cors_origins) && v.reports_cors_origins.includes(app), `reports_cors_origins must contain ${app}`);
  need(Array.isArray(v.api_cors_origins) && v.api_cors_origins.includes(app), `api_cors_origins must contain ${app}`);
  for (const name of ['app_callback_urls', 'app_logout_urls', 'reports_cors_origins', 'api_cors_origins']) {
    need((v[name] ?? []).every((u) => typeof u === 'string' && u.startsWith('https://') && !/localhost|127\.0\.0\.1/.test(u)), `${name} must be https and not a local address`);
  }
  need(/condition\s*=\s*contains\(var\.app_callback_urls, "https:\/\/\$\{local\.web_app\}\/auth\/callback"\) && contains\(var\.app_logout_urls, "https:\/\/\$\{local\.web_app\}\/signed-out"\) && contains\(var\.reports_cors_origins, "https:\/\/\$\{local\.web_app\}"\)/.test(webText), 'web.tf must still carry the precondition this example satisfies');

  // Placeholders stay recognisable as placeholders, and nothing real is written down.
  need(/@example\.com$/.test(v.alarm_email ?? ''), 'alarm_email must stay an @example.com placeholder in a committed file');
  need(typeof v.cognito_domain_prefix === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(v.cognito_domain_prefix), 'cognito_domain_prefix must be a valid prefix');
  need(!/\b\d{12}\b|AKIA[0-9A-Z]{16}|sha256:[0-9a-f]{64}|-----BEGIN|password\s*=|secret\s*=/i.test(exampleText.replace(/<account>|<64 hex>/g, '')), 'the example must not contain an account id, key, digest, password or secret');
  need(exampleText.includes('docs/ops/staging-plan-review.md') && exampleText.includes('PLACEHOLDER'), 'the example must point to the review page and mark its placeholders');
  return problems;
}

test('the staged example is in step with its offline test and inside the staging envelope', () => {
  assert.ok(Object.keys(assignments(example).values).length >= 12, 'the scan found the example (a floor, so an empty read cannot pass)');
  assert.deepEqual(stagingProblems(example), []);
});

test('the first-image update list matches the four existing execution-policy bindings and the review page', () => {
  const compute = read('api-compute.tf');
  const worker = read('worker.tf');
  const page = readFileSync(new URL('../../docs/ops/staging-plan-review.md', dir), 'utf8');
  const block = (text, header) => {
    const start = text.indexOf(header);
    assert.ok(start >= 0, `missing ${header}`);
    return text.slice(start, text.indexOf('\n}', start) + 2);
  };
  assert.equal(IMAGE_POLICY_UPDATES.length, 4);
  for (const address of IMAGE_POLICY_UPDATES) {
    const name = address.match(/^aws_iam_role_policy\.([a-z_]+)\[0\]$/)[1];
    const source = name === 'worker_execution' ? worker : compute;
    const resource = block(source, `resource "aws_iam_role_policy" "${name}"`);
    assert.match(resource, /count\s*=\s*local\.api_count/);
    assert.ok(resource.includes(`data.aws_iam_policy_document.${name}[0].json`), `${address} must retain its policy document`);
    const policy = block(source, `data "aws_iam_policy_document" "${name}"`);
    if (name === 'worker_execution') assert.match(policy, /resources\s*=\s*\[local\.api_repository\]/);
    else assert.match(policy, /source_policy_documents\s*=\s*\[data\.aws_iam_policy_document\.api_execution_common\.json\]/);
    assert.ok(page.includes(address), `the operator must review ${address}`);
  }
  assert.match(block(compute, 'data "aws_iam_policy_document" "api_execution_common"'), /resources\s*=\s*\[local\.api_repository\]/);
  assert.ok(page.includes('scripts/staging/check-plan.mjs'));
  assert.ok(!page.includes('Plans B and C against the state left by the one before must be create-only too'));
});

test('the staged-example guard reports each way it could be weakened (controls)', () => {
  const edit = (from, to) => {
    assert.ok(example.includes(from), `the control must match the real example text: ${from}`);
    return example.replace(from, to);
  };
  const append = (extra) => `${example}\n${extra}\n`;
  const weakened = [
    ['production environment', edit('environment        = "staging"', 'environment        = "production"')],
    ['production profile', edit('deployment_profile = "synthetic"', 'deployment_profile = "production"')],
    ['api_domain left at the default', edit('api_domain = "api.staging.telesphoros.app"', 'api_domain = "api.telesphoros.app"')],
    ['web_domain is the real domain', edit('web_domain = "staging.telesphoros.app"', 'web_domain = "telesphoros.app"')],
    ['callback for another host', edit('"https://app.staging.telesphoros.app/auth/callback"', '"https://app.telesphoros.app/auth/callback"')],
    ['logout missing', edit('app_logout_urls      = ["https://app.staging.telesphoros.app/signed-out"]', 'app_logout_urls      = []')],
    ['an http origin', edit('api_cors_origins     = ["https://app.staging.telesphoros.app"]', 'api_cors_origins     = ["http://app.staging.telesphoros.app"]')],
    ['a local origin', edit('api_cors_origins     = ["https://app.staging.telesphoros.app"]', 'api_cors_origins     = ["https://app.staging.telesphoros.app", "https://localhost"]')],
    ['a supplied network', append('vpc_id = "vpc-0123456789abcdef0"')],
    ['a supplied security group', append('app_security_group_ids = ["sg-0123456789abcdef0"]')],
    ['an image written down', append('api_image = "123456789012.dkr.ecr.us-east-2.amazonaws.com/x@sha256:0000000000000000000000000000000000000000000000000000000000000000"')],
    ['a COMPLIANCE lock', append('audit_lock_mode = "COMPLIANCE"')],
    ['database protection written in', append('db_deletion_protection = true')],
    ['region decided early', append('region = "us-west-2"')],
    ['a variable that does not exist', append('enable_everything = true')],
    ['a real alarm address', edit('alarm_email = "security@example.com"', 'alarm_email = "jan@gmail.com"')],
    ['web hosting off in the example', edit('enable_web_hosting = true', 'enable_web_hosting = false')],
    ['a secret written in', append('db_password = "hunter2"')],
    ['a trailing comment on an assignment', edit('alarm_email = "security@example.com"', 'alarm_email = "security@example.com" # mine')],
    ['the review page no longer named', edit('docs/ops/staging-plan-review.md', 'somewhere else')],
  ];
  for (const [name, broken] of weakened) assert.ok(stagingProblems(broken).length > 0, `a weakened example must be reported: ${name}`);
  // And the other side: the test's values drifting from the example.
  const driftedTest = tftest.replace('cognito_domain_prefix = "telesphoros-staging"', 'cognito_domain_prefix = "something-else"');
  assert.notEqual(driftedTest, tftest);
  assert.ok(stagingProblems(example, driftedTest).length > 0, 'a test that plans different values than the example must be reported');
  // And the module side: the precondition or the policy host changing under the example.
  assert.ok(stagingProblems(example, tftest, webTf.replace('"https://api.${var.web_domain}"', '"https://backend.${var.web_domain}"')).length > 0, 'a change to the host the page allows must be reported');
  assert.ok(stagingProblems(example, tftest, webTf.replace('contains(var.app_logout_urls, "https://${local.web_app}/signed-out")', 'true')).length > 0, 'a change to the web precondition must be reported');
  assert.deepEqual(stagingProblems(example), []); // control: the unchanged text is clean
});
