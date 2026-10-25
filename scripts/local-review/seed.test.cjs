// Runs the demo seed for real: a new database, every migration, the seed twice. Needs a disposable PostgreSQL superuser URL in TEST_DATABASE_URL
// (the one the backend's database tier uses); without it the test is skipped and says so. It creates and drops its own database.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { createRequire } = require('node:module');
const { derivePersonas } = require('./personas.cjs');

const url = process.env.TEST_DATABASE_URL;

test('setup seeds the demo organizations and members on an empty database, twice without change', { skip: url ? false : 'TEST_DATABASE_URL is not set' }, async () => {
  const root = path.resolve(__dirname, '../..');
  const { Client } = createRequire(path.join(root, 'apps/backend/package.json'))('pg');
  const { migrateUp } = require('../../apps/backend/dist/db/migrator');
  const { seedPersonas } = require('./seed.cjs');
  const name = `demo_seed_${randomBytes(6).toString('hex')}`;
  const admin = new Client({ connectionString: url });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const target = new URL(url);
  target.pathname = `/${name}`;
  const db = new Client({ connectionString: target.toString() });
  try {
    await db.connect();
    await migrateUp(db);
    const expected = derivePersonas();
    const first = await seedPersonas(db);
    assert.deepEqual(first, { tenants: expected.tenants.length, members: expected.grants.length, changed: expected.grants.length });
    const { rows } = await db.query("SELECT tenant_id, sub, roles FROM tenant_memberships WHERE status = 'active' ORDER BY sub");
    assert.equal(rows.length, expected.grants.length);
    for (const g of expected.grants) {
      const row = rows.find((r) => r.sub === g.sub);
      assert.ok(row, `${g.email} has an active membership`);
      assert.equal(row.tenant_id, g.tenantId);
      assert.deepEqual([...row.roles].sort(), [...g.roles].sort());
    }
    const second = await seedPersonas(db);
    assert.equal(second.changed, 0, 'a second run changes nothing');
  } finally {
    await db.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  }
});
