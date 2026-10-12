const { test } = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path'); const { randomUUID } = require('node:crypto');
const { scheduler, clockCheck, INTERVAL_MS } = require('./scheduler.cjs'); const o = require('./ownership.cjs');
const { ports } = require('./runtime.cjs');
test('startup reconciles before arming the 15-minute non-overlapping schedule', async () => {
  const callbacks = []; const events = []; let calls = 0, release;
  const scheduled = scheduler(async () => { calls++; if (calls === 2) await new Promise(r => { release = r; }); return { cleaned: 0 }; }, { later: (fn, ms) => { assert.equal(ms, 900000); callbacks.push(fn); return callbacks.length; }, cancel: () => {}, record: e => events.push(e) });
  await scheduled.start(); assert.equal(calls, 1); assert.equal(INTERVAL_MS, 900000);
  const tick = callbacks[0](); const repeated = scheduled.run(); assert.equal(calls, 2);
  release(); await tick; await repeated; assert.equal(calls, 2); assert.equal(events.length, 2); await scheduled.stop();
});
test('startup reconciliation failure refuses scheduling; periodic failure is explicit and retryable', async () => {
  let calls = 0, next; const records = [];
  const fail = scheduler(async () => { throw new Error('Synthetic outage'); }, { later: () => assert.fail('timer after failed startup'), record: e => records.push(e) });
  await assert.rejects(fail.start()); assert.equal(records[0].success, false); await fail.stop();
  const s = scheduler(async () => { if (++calls === 2) throw new Error('Synthetic outage'); return {}; }, { later: fn => { next = fn; }, cancel: () => {}, record: e => records.push(e) });
  await s.start(); await next(); assert.equal(records.at(-1).success, false); await next(); assert.equal(records.at(-1).success, true); await s.stop();
});
test('wall-clock skew and long clock requests refuse independently of monotonic scheduling', () => {
  assert.equal(clockCheck({ hostBefore: 10000, hostAfter: 10020, database: 10010, emulator: 10000 }).passed, true);
  for (const value of [NaN, -1, 16021]) assert.throws(() => clockCheck({ hostBefore: 10000, hostAfter: 10020, database: value, emulator: 10000 }));
  assert.throws(() => clockCheck({ hostBefore: 10000, hostAfter: 16000, database: 11000, emulator: 11000 }));
});
function fixture() {
  o.ensureBase(); const id = randomUUID(), root = o.location(id); fs.mkdirSync(root, { mode: 0o700 });
  const m = { schema: 1, synthetic: true, id, root, directory: o.privateDir(root), host: '127.0.0.1', ports, database: 'synthetic_storage_' + id.replaceAll('-', ''), role: 'storage_app', bucket: 'synthetic-storage-' + id, clinicalProcessing: 'disabled', phase: 'preparing', processes: [] };
  o.seal(m); return m;
}
test('a changed or missing manifest cannot authorize deletion', () => {
  const m = fixture(); const file = path.join(m.root, 'manifest.json'); const original = o.read(file);
  o.atomic(file, original.replace('disabled', 'enabled')); assert.throws(() => o.load(m.id)); assert.ok(fs.existsSync(m.root));
  fs.unlinkSync(file); assert.throws(() => o.load(m.id)); o.atomic(file, original); o.remove(m);
});
test('foreign root entry and symlink target survive ownership refusal', () => {
  const m = fixture(); const sentinel = path.join(m.root, 'foreign-sentinel'); fs.writeFileSync(sentinel, 'synthetic-preserve', { mode: 0o600 });
  assert.throws(() => o.load(m.id)); assert.equal(fs.readFileSync(sentinel, 'utf8'), 'synthetic-preserve'); fs.unlinkSync(sentinel);
  const link = path.join(m.root, 'tmp'); fs.symlinkSync(o.base, link); assert.throws(() => o.checkTree(m.root)); assert.ok(fs.existsSync(o.base)); fs.unlinkSync(link); o.remove(m);
});
test('non-loopback targets and substituted directory identities refuse', () => {
  const m = fixture(); assert.throws(() => o.validate({ ...m, host: 'example.com' })); assert.throws(() => o.validate({ ...m, root: '/tmp' }));
  o.seal({ ...m, directory: { ...m.directory, ino: m.directory.ino + 1 } }); assert.throws(() => o.load(m.id)); o.seal(m); o.remove(m);
});
test('reused process identity refuses and repeated empty teardown is idempotent', async () => {
  assert.throws(() => o.live({ pid: process.pid, identity: 'foreign' }));
  const m = fixture(); o.remove(m); assert.equal((await require('./runtime.cjs').teardown(m.id)).phase, 'removed');
});
test('occupied foreign port refuses without contacting or stopping its server', async () => {
  const server = require('node:net').createServer(() => assert.fail('must not contact foreign server'));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try { await assert.rejects(o.free(server.address().port), /Occupied/); assert.equal(server.listening, true); } finally { await new Promise(r => server.close(r)); }
});
test('any reconciliation failure closes admission; only a successful retry reopens it', async () => {
  const { guardAdmission } = require('./scheduler.cjs'); const events = []; let fail = true;
  const guarded = guardAdmission(async () => { events.push('inventory'); if (fail) throw new Error('Missing ownership receipt'); return {}; }, async () => events.push('open'), async () => events.push('close'));
  await assert.rejects(guarded()); assert.deepEqual(events, ['inventory', 'close']);
  fail = false; await guarded(); assert.deepEqual(events, ['inventory', 'close', 'inventory', 'open']);
});
