// The demo's memberships come from the fake identity provider's users, and the verify scripts sign in as some of them. These tests fail when a
// verify script signs in as someone who would not be seeded, when setup stops seeding, or when a failure report would print more than it should.
// No database needed: the seed itself is run for real by seed.test.cjs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DEFAULT_USERS } = require('../../packages/fake-idp/dist/index.js');
const { derivePersonas, ROLE_GROUPS } = require('./personas.cjs');
const { reportFailure } = require('./report-failure.cjs');

const dir = __dirname;
const read = (name) => fs.readFileSync(path.join(dir, name), 'utf8');
const VERIFY_SCRIPTS = fs.readdirSync(dir).filter((f) => /^verify-[\w-]+\.cjs$/.test(f));

test('the seed covers exactly the users with one organization and at least one role', () => {
  const { tenants, grants } = derivePersonas(DEFAULT_USERS);
  assert.deepEqual(tenants, ['alpha', 'beta']);
  assert.equal(grants.length, 6, 'alice, bob, carol, gina, hal and ivy');
  for (const g of grants) {
    const user = DEFAULT_USERS.find((u) => u.sub === g.sub);
    assert.ok(user.groups.includes(`tenant:${g.tenantId}`));
    assert.deepEqual(new Set(g.roles), new Set(user.groups.filter((x) => ROLE_GROUPS.includes(x))));
  }
});

test('a user with no organization, two organizations or no role is left out', () => {
  const user = (groups) => ({ sub: '00000000-0000-4000-8000-000000000000', email: 'x@example.test', groups });
  assert.deepEqual(derivePersonas([user(['clinician'])]).grants, []);
  assert.deepEqual(derivePersonas([user(['clinician', 'tenant:alpha', 'tenant:beta'])]).grants, []);
  assert.deepEqual(derivePersonas([user(['tenant:alpha'])]).grants, []);
  assert.equal(derivePersonas([user(['reader', 'tenant:alpha'])]).grants.length, 1);
});

test('every user a verify script signs in as is seeded with the roles in their token', () => {
  const { grants } = derivePersonas(DEFAULT_USERS);
  const used = new Set();
  for (const script of VERIFY_SCRIPTS) for (const m of read(script).matchAll(/DEFAULT_USERS\[(\d+)\]/g)) used.add(Number(m[1]));
  assert.ok(used.size >= 3, 'the scripts name at least the clinician, the reviewer and an outsider');
  for (const index of used) {
    const user = DEFAULT_USERS[index];
    assert.ok(user, `DEFAULT_USERS[${index}] exists`);
    assert.ok(grants.some((g) => g.sub === user.sub), `${user.email} (DEFAULT_USERS[${index}]) is seeded; without a membership the API answers 403`);
  }
});

test('database setup runs the seed after the migrations, and no verify script prints its own failure report', () => {
  const setup = read('database.cjs');
  const migrate = setup.indexOf('migrateUp(db)');
  const seed = setup.indexOf("require('./seed.cjs').seedPersonas(db)");
  assert.ok(migrate > 0 && seed > migrate, 'setup must call seedPersonas(db) after migrateUp(db)');
  for (const script of VERIFY_SCRIPTS) {
    const text = read(script);
    assert.match(text, /\.catch\(require\('\.\/report-failure\.cjs'\)\.reportFailure\)/, `${script} reports through report-failure.cjs`);
    assert.doesNotMatch(text, /FAIL local upload checks/, `${script} has no private failure message`);
  }
});

test('the storage demo runtime seeds the same demo users, after its migrations', () => {
  const runtime = read('../local-storage/runtime.cjs');
  const migrate = runtime.indexOf("migrateUp(owner)");
  const seed = runtime.indexOf("require('../local-review/seed.cjs').seedPersonas(owner)");
  assert.ok(migrate > 0 && seed > migrate, 'runtime.cjs must call seedPersonas(owner) after migrateUp(owner), or every demo user gets "No organization is assigned"');
});

function capture(fn) {
  const lines = [];
  const original = console.error;
  const code = process.exitCode;
  console.error = (...a) => lines.push(a.join(' '));
  try {
    fn();
  } finally {
    console.error = original;
    process.exitCode = code;
  }
  return lines.join('\n');
}

test('a failed assertion names the script, the line and two short values', () => {
  let error;
  try {
    assert.equal(403, 201);
  } catch (e) {
    error = e;
  }
  error.stack = `AssertionError\n    at /somewhere/scripts/local-review/verify-review.cjs:44:82`;
  const out = capture(() => reportFailure(error));
  assert.match(out, /failed at verify-review\.cjs line 44/);
  assert.match(out, /got 403, expected 201/);
  assert.match(out, /FAIL local upload checks \(no token\/configuration output\)/);
});

test('a failure report never prints objects or long strings', () => {
  const secret = 'Bearer ' + 'x'.repeat(200);
  const error = Object.assign(new Error('boom'), { name: 'AssertionError', actual: { authorization: secret }, expected: secret });
  const out = capture(() => reportFailure(error));
  assert.doesNotMatch(out, /Bearer|authorization|xxxx/);
  assert.doesNotMatch(out, /got /);
});
