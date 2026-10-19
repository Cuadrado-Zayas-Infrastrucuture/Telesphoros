const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, writeFileSync, symlinkSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { install, observe, classify } = require('./setup.cjs');
const { emitter } = require('./trace.cjs');
const backend = resolve(__dirname, '../../apps/backend');
const secret = 'FORBIDDEN_DIAGNOSTIC_ARGUMENT';

function harness(t, work) {
  const factories = new Map(), records = [];
  class Client {
    constructor() { this.processID = 123; }
    connect(callback) { return callback ? undefined : Promise.resolve(this); }
    query(text, values, callback) { return callback ? undefined : Promise.resolve({ rows: [] }); }
    end() { return 42; }
  }
  const actual = { Client, Pool: class Pool {} };
  const raw = Object.defineProperty({ migrateUp: () => Promise.resolve([]) }, 'lazy', { get() { throw new Error('do not inspect unrelated exports'); } });
  const helper = { createEphemeralDatabase: work ?? (async function () {
    const pg = factories.get('pg')(), client = new pg.Client();
    assert.equal(this.marker, true); await client.connect();
    await client.query('SELECT pg_advisory_lock($1)', [4242, secret]);
    await factories.get(join(backend, 'src/db/migrator.ts'))().migrateUp(client);
    return client.end();
  }) };
  const api = { expect: { getState: () => ({ testPath: join(backend, 'test/db/system-actor.pg-spec.ts') }) },
    jest: { doMock: (name, factory) => factories.set(name, factory), requireActual: name => name === 'pg' ? actual : name.endsWith('migrator.ts') ? raw : helper }, afterAll: () => {} };
  const observer = install(api, { pgPath: 'pg', migrations: new Map([['MIGRATION_SQL_' + secret, 'migration:0001']]), emit: record => records.push(record) });
  t.after(observer.close);
  return { factories, records, actual, helper: () => factories.get(join(backend, 'test/helpers/database.ts'))() };
}

test('actual Client/Pool identity, callback results, receivers, lazy exports and fixture results survive observation', async t => {
  const h = harness(t);
  const pg = h.factories.get('pg')();
  assert.equal(pg, h.actual); assert.equal(pg.Client, h.actual.Client);
  const c = new pg.Client(), callback = () => {};
  assert.equal(c.connect(callback), undefined); assert.equal(c.query('SELECT $1', [secret], callback), undefined); assert.equal(c.end(), 42);
  const value = await h.helper().createEphemeralDatabase.call({ marker: true }, { password: secret });
  assert.equal(value, 42);
  assert.ok(h.records.some(row => row.event === 'operation-start' && row.phase === 'role-lock'));
  assert.ok(h.records.some(row => row.event === 'fixture-end' && row.ok));
  assert.equal(JSON.stringify(h.records).includes(secret), false);
});

test('synchronous throws and promise rejections retain their exact objects and native failure semantics', async t => {
  const failure = new Error(secret), receiver = { marker: true };
  assert.throws(() => observe(function (arg) { assert.equal(this, receiver); assert.equal(arg, secret); throw failure; }, receiver, [secret], () => {}), error => error === failure);
  await assert.rejects(observe(() => Promise.reject(failure), null, [], () => {}), error => error === failure);
  const h = harness(t, () => Promise.reject(failure));
  await assert.rejects(h.helper().createEphemeralDatabase(), error => error === failure);
  assert.equal(h.records.find(row => row.event === 'fixture-end').ok, false);
  assert.ok(!JSON.stringify(h.records).includes(secret));
});

test('dropping an observed rejected promise still fails the native process', () => {
  const file = require.resolve('./setup.cjs');
  const child = spawnSync(process.execPath, ['--unhandled-rejections=strict', '-e', `require(${JSON.stringify(file)}).observe(() => Promise.reject(new Error('synthetic refusal')), null, [], () => {}); setTimeout(() => {}, 10)`], { encoding: 'utf8' });
  assert.equal(child.status, 1);
});

test('a four-second probe names the active fixture phase without printing SQL or values', async t => {
  let h;
  h = harness(t, async () => {
    const pg = h.factories.get('pg')(), client = new pg.Client();
    // A disposable synthetic delayed query models the original uncompleted await.
    return client.query('SELECT pg_advisory_lock($1)', [4242, secret]);
  });
  const pg = h.actual;
  pg.Client.prototype.query = function () { return new Promise(done => setTimeout(() => done(7), 4100)); };
  assert.equal(await h.helper().createEphemeralDatabase(), 7);
  const probe = h.records.find(row => row.event === 'fixture-four-seconds');
  assert.ok(probe); assert.equal(probe.active[0].phase, 'role-lock'); assert.equal(probe.active[0].backendPid, 123);
  assert.ok(probe.active[0].ageMs >= 3900); assert.ok(!JSON.stringify(h.records).includes(secret));
});

test('query classification emits only fixed phase labels and migration IDs', () => {
  const migrations = new Map([['MIGRATION_' + secret, 'migration:0001']]);
  assert.equal(classify('MIGRATION_' + secret, [], migrations), 'migration:0001');
  assert.equal(classify('CREATE DATABASE ' + secret, [], migrations), 'database-create');
  assert.equal(classify(secret, [secret], migrations), 'other-sql');
});

test('trace files reject symlinks and record a bounded failure instead of masking an application error', t => {
  const dir = mkdtempSync(join(tmpdir(), 'fixture-capture-record-'));
  // Blast radius: only this newly-created synthetic test directory; recreate by rerunning this control.
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const target = join(dir, 'target'); writeFileSync(target, secret); symlinkSync(target, join(dir, 'setup.jsonl'));
  assert.throws(() => emitter('setup.jsonl', dir)); assert.equal(readFileSync(target, 'utf8'), secret);
  const emit = emitter('preload.jsonl', dir);
  emit({ event: 'synthetic-limit-control', count: 1, padding: 'x'.repeat(128 * 1024) });
  assert.ok(readFileSync(join(dir, 'capture-errors.jsonl'), 'utf8').includes('capture-error'));
});
