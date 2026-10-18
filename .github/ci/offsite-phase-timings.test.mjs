import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import observer from './offsite-phase-timings.cjs';

const fixture = t => {
  const dir = mkdtempSync(join(tmpdir(), 'pr163-phase-control-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, events: () => readFileSync(join(dir, 'offsite-phases.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) };
};

test('timing preserves receivers, arguments, return values and exact thrown errors without logging payloads', t => {
  const f = fixture(t); const trace = observer.recorder(f.dir); const receiver = {};
  const payload = 'FORBIDDEN-DIAGNOSTIC-PAYLOAD'; const failure = new Error(payload);
  trace.begin(1);
  assert.equal(trace.timed('control', function (value) { assert.equal(this, receiver); assert.equal(value, payload); return receiver; }, receiver, [payload]), receiver);
  assert.throws(() => trace.timed('refusal', () => { throw failure; }, null, [payload]), error => error === failure);
  trace.end(); trace.close();
  assert.equal(JSON.stringify(f.events()).includes(payload), false);
  assert.deepEqual(f.events().filter(x => x.event === 'end').map(x => x.ok), [true, false]);
});

test('timing preserves fulfilled values and exact rejection objects', async t => {
  const f = fixture(t); const trace = observer.recorder(f.dir); const value = {};
  const successful = Promise.resolve(value); const failure = new Error('synthetic refusal');
  const rejected = Promise.reject(failure);
  const success = trace.timed('success', () => successful, null, []);
  const refusal = trace.timed('refusal', () => rejected, null, []);
  assert.equal(await success, value);
  await assert.rejects(refusal, error => error === failure);
  trace.close();
  assert.deepEqual(f.events().filter(x => x.event === 'end').map(x => x.ok), [true, false]);
});

test('an operation finishing after a test boundary retains its original test and parent span', async t => {
  const f = fixture(t); const trace = observer.recorder(f.dir);
  let finish; const delayed = new Promise(resolve => { finish = resolve; });
  trace.begin(1);
  const parent = trace.timed('parent', async () => { await delayed; return trace.timed('child', () => 1, null, []); }, null, []);
  trace.end(); trace.begin(2); finish(); await parent; trace.end(); trace.close();
  const starts = f.events().filter(x => x.event === 'start');
  assert.equal(starts[1].test, 1); assert.equal(starts[1].parent, starts[0].span);
  assert.ok(f.events().filter(x => x.event === 'end').every(x => x.test === 1));
});

test('a stale trace cannot be overwritten or accepted as this invocation', t => {
  const f = fixture(t); const trace = observer.recorder(f.dir); trace.close();
  const original = readFileSync(join(f.dir, 'offsite-phases.jsonl'));
  assert.throws(() => observer.recorder(f.dir), error => error.code === 'EEXIST');
  assert.deepEqual(readFileSync(join(f.dir, 'offsite-phases.jsonl')), original);
});

test('an ignored returned rejection still fails the native process; an explicitly handled refusal succeeds', t => {
  const f = fixture(t); const file = fileURLToPath(new URL('./offsite-phase-timings.cjs', import.meta.url));
  for (const handled of [false, true]) {
    const script = `const trace = require(${JSON.stringify(file)}).recorder(${JSON.stringify(join(f.dir, handled ? 'handled' : 'ignored'))});
      const result = trace.timed('refusal', () => Promise.reject(new Error('SYNTHETIC_UNHANDLED_REFUSAL')), null, []);
      ${handled ? 'result.catch(() => {});' : ''}
      setTimeout(() => trace.close(), 10);`;
    const child = spawnSync(process.execPath, ['--unhandled-rejections=strict', '-e', script], { encoding: 'utf8' });
    assert.equal(child.status, handled ? 0 : 1);
    if (!handled) assert.match(child.stderr, /SYNTHETIC_UNHANDLED_REFUSAL/);
  }
});

test('module cloning preserves lazy descriptors without evaluating unrelated exports', () => {
  const actual = Object.defineProperty({ operation: () => 1 }, 'lazy', { get() { throw new Error('must remain lazy'); } });
  const replacement = () => 2; const cloned = observer.cloneExports(actual, { operation: replacement });
  assert.equal(cloned.operation, replacement);
  assert.equal(Object.getOwnPropertyDescriptor(cloned, 'lazy').get, Object.getOwnPropertyDescriptor(actual, 'lazy').get);
});

test('all other suites are untouched; observed pg callbacks and promises keep their original contract', async t => {
  assert.equal(observer.install({ expect: { getState: () => ({ testPath: '/other.spec.ts' }) } }, {}), null);
  const f = fixture(t); const factories = new Map(); const hooks = [];
  const callbacks = []; const promise = Promise.resolve({ rows: [] });
  class Client {
    constructor(configuration) { this.configuration = configuration; }
    connect(...args) { callbacks.push(...args); return args.length ? undefined : promise; }
    query(...args) { callbacks.push(...args.filter(x => typeof x === 'function')); return args.some(x => typeof x === 'function') ? undefined : promise; }
    end(...args) { callbacks.push(...args); return args.length ? undefined : promise; }
  }
  const actual = { Client, Pool: class Pool {} };
  const trace = observer.install({ expect: { getState: () => ({ testPath: '/test/db/offsite-restore.pg-spec.ts' }) },
    jest: { doMock: (file, factory) => factories.set(file, factory), requireActual: file => { assert.equal(file, 'pg'); return actual; } },
    beforeEach: hook => hooks.push(hook), afterEach: hook => hooks.push(hook),
  }, { OFFSITE_PHASE_TRACE_DIR: f.dir, TEST_DATABASE_URL: 'FORBIDDEN-DIAGNOSTIC-CONFIG' });
  const pg = factories.get('pg')(); const config = {}; const client = new pg.Client(config); const callback = () => {};
  assert.ok(client instanceof Client); assert.equal(client.configuration, config); assert.equal(pg.Pool, actual.Pool);
  assert.equal(client.connect(callback), undefined); assert.equal(client.query('SELECT $1', ['FORBIDDEN-DIAGNOSTIC-ARGUMENT'], callback), undefined); assert.equal(client.end(callback), undefined);
  assert.deepEqual(callbacks, [callback, callback, callback]);
  hooks[0](); assert.equal(await client.query('SELECT $1', ['FORBIDDEN-DIAGNOSTIC-ARGUMENT']), await promise); hooks[1](); trace.close();
  const output = JSON.stringify(f.events()); assert.equal(output.includes('FORBIDDEN'), false);
  assert.equal(f.events().filter(x => x.event === 'start').length, 1);
});
