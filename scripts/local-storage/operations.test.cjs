const { test } = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path'); const { randomUUID } = require('node:crypto');
const { scheduler, clockCheck, INTERVAL_MS } = require('./scheduler.cjs'); const o = require('./ownership.cjs');
const { ports } = require('./runtime.cjs');

// Exercise real configuration and initial manifest creation without starting services
// or creating files. Only the external requirements bytes and installed version vary.
function versionFixture(requirements, installed) {
  const file = require.resolve('./runtime.cjs');
  const root = path.resolve(__dirname, '../..');
  const boundary = new Error('Synthetic initial manifest captured');
  const state = { effects: 0 };
  const ownership = {
    root, ensureBase() { state.effects++; }, free: async () => {},
    location: id => path.join('/synthetic', id), privateDir: () => ({}),
    seal(m) { state.manifest = m; throw boundary; },
  };
  const module = { exports: {} };
  const localRequire = require('node:module').createRequire(file);
  require('node:vm').runInNewContext(fs.readFileSync(file, 'utf8'), {
    module, __dirname, setTimeout,
    process: { env: { LOCAL_PG_BIN: '/synthetic/pg', MOTO_SERVER: '/synthetic/moto/bin/moto_server' }, versions: { node: '22.23.5' } },
    require: name => {
      if (name === './ownership.cjs') return ownership;
      if (name === './services.cjs') return {};
      if (name === 'node:fs') return {
        readFileSync(target) { assert.equal(target, path.join(root, '.github/ci/requirements.in')); return requirements; },
        mkdirSync() { state.effects++; },
      };
      if (name === 'node:child_process') return { execFileSync(bin, args) {
        if (args.includes('--version')) return 'PostgreSQL 16.0';
        if (args.includes('-c')) { assert.equal(bin, '/synthetic/moto/bin/python'); return installed + '\n'; }
        return 'synthetic-head';
      }, fork() { assert.fail('no service may start in a version control'); } };
      return localRequire(name);
    },
  }, { filename: file, timeout: 5000 });
  return { runtime: module.exports, state, boundary };
}

test('requirements pin changes propagate to launcher validation and its manifest without code changes', async () => {
  const requirements = fs.readFileSync(path.resolve(__dirname, '../../.github/ci/requirements.in'), 'utf8');
  const current = /^moto\[server\]==(\d+\.\d+\.\d+)/m.exec(requirements)[1];
  for (const pin of [current, '9.8.7']) {
    const changed = requirements.replace(/^moto\[server\]==[^\r\n]+/m, 'moto[server]==' + pin);
    const accepted = versionFixture(changed, pin);
    await assert.rejects(accepted.runtime.setup(), error => error === accepted.boundary);
    assert.equal(accepted.state.manifest.versions.moto, pin);
    for (const installed of new Set(['0.0.0', current])) {
      if (installed === pin) continue;
      const refused = versionFixture(changed, installed);
      await assert.rejects(refused.runtime.setup(), error => error.message === `Moto ${pin} required.`);
      assert.equal(refused.state.effects, 0, 'mismatch refuses before creating owned resources');
    }
  }
});

test('missing, unpinned, malformed and duplicate Moto requirements fail before setup', async () => {
  for (const requirements of ['', '# moto[server]==9.8.7\n', 'moto[server]>=9.8.7\n', 'moto[server]==garbage\n',
    'moto[server]==9.8.7\nmoto[server]==9.8.7\n', 'moto[server]==9.8.7\nmoto[server]>=9.8.7\n']) {
    const refused = versionFixture(requirements, '9.8.7');
    await assert.rejects(refused.runtime.setup(), /Exactly one pinned Moto requirement/);
    assert.equal(refused.state.effects, 0);
  }
});
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
test('failed durable sweep recording closes admission; persistence precedes a successful reopen', async () => {
  const { guardAdmission } = require('./scheduler.cjs'); const events = []; let fail = true;
  const failure = new Error('Synthetic status write failure');
  const guarded = guardAdmission(async () => { events.push('reconcile'); return {}; }, async () => events.push('open'), async () => events.push('close'), async result => {
    events.push(result.success ? 'persist-success' : 'persist-failure');
    if (fail) throw failure;
  });
  await assert.rejects(guarded(), error => error === failure);
  assert.deepEqual(events, ['reconcile', 'persist-success', 'close', 'persist-failure']);
  fail = false; await guarded();
  assert.deepEqual(events.slice(4), ['reconcile', 'persist-success', 'open']);
});
test('failed atomic rename removes only its exclusive temporary and preserves the destination', () => {
  const m = fixture(), target = path.join(m.root, 'sweeps.json'); fs.mkdirSync(target, { mode: 0o700 });
  const sentinel = path.join(target, 'sentinel'); fs.writeFileSync(sentinel, 'preserve', { mode: 0o600 });
  try {
    assert.throws(() => o.atomic(target, 'synthetic'));
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'preserve');
    assert.deepEqual(fs.readdirSync(m.root).sort(), ['manifest.json', 'sweeps.json']);
    assert.equal(o.load(m.id).id, m.id);
  } finally { fs.unlinkSync(sentinel); fs.rmdirSync(target); o.remove(m); }
});
test('directory fsync failure reports failure without removing the renamed destination', () => {
  const m = fixture(), target = path.join(m.root, 'sweeps.json'), fsync = fs.fsyncSync; let calls = 0;
  try {
    fs.fsyncSync = fd => { if (++calls === 2) throw new Error('Synthetic directory sync failure'); return fsync(fd); };
    assert.throws(() => o.atomic(target, 'durable-outcome'), /sync failure/);
    assert.equal(o.read(target), 'durable-outcome');
    assert.deepEqual(fs.readdirSync(m.root).sort(), ['manifest.json', 'sweeps.json']);
  } finally { fs.fsyncSync = fsync; o.remove(m); }
});
test('supervisor defers locked maintenance without reading partial receipts, then detects failures', () => {
  const { health } = require('./runtime.cjs'); const m = fixture(), file = path.join(m.root, 'manifest.json'), original = o.read(file);
  const unlock = o.lock(m.id);
  try {
    o.atomic(file, original.replace('disabled', 'enabled'));
    assert.equal(health(m.id), 'busy');
  } finally { o.atomic(file, original); unlock(); }
  assert.equal(health(m.id), 'unhealthy');
  m.phase = 'ready'; o.seal(m); assert.equal(health(m.id), 'unhealthy', 'missing workers are not healthy');
  const lockFile = path.join(o.base, 'control', m.id + '.lock'); o.atomic(lockFile, '{}');
  assert.throws(() => health(m.id), 'invalid locks must not hide a failure'); fs.unlinkSync(lockFile);
  o.remove(m); assert.equal(health(m.id), 'removed');
});
test('lock publication is complete and exclusive; a release race retries health safely', () => {
  const { health } = require('./runtime.cjs'); const m = fixture(), file = path.join(o.base, 'control', m.id + '.lock');
  const link = fs.linkSync, lstat = fs.lstatSync; let publications = 0;
  try {
    fs.linkSync = (source, destination) => {
      assert.equal(JSON.parse(o.read(source)).pid, process.pid);
      publications++; return link(source, destination);
    };
    const unlock = o.lock(m.id);
    assert.throws(() => o.lock(m.id), o.OperationBusyError);
    let released = false;
    fs.lstatSync = (...args) => { if (args[0] === file && !released) { released = true; unlock(); } return lstat(...args); };
    assert.equal(health(m.id), 'unhealthy'); assert.equal(released, true); assert.equal(publications, 2);
    assert.equal(fs.existsSync(file), false);
  } finally { fs.linkSync = link; fs.lstatSync = lstat; if (fs.existsSync(file)) fs.unlinkSync(file); o.remove(m); }
});
// PostgreSQL deletes its own temporary-relation and relcache files while it runs (seen on CI: the
// teardown preflight failed after every demo test passed). Make one file and one directory vanish
// mid-walk, the way a live cluster does, and prove teardown still completes while tampering refuses.
function vanishing(m) {
  const base = path.join(m.root, 'postgres', 'base'); const file = path.join(base, '1', 't3_16384'); const dir = path.join(base, 'pgsql_tmp', 'pgsql_tmp7.0.fileset');
  fs.mkdirSync(path.join(base, '1'), { recursive: true, mode: 0o700 }); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, 'synthetic', { mode: 0o600 }); fs.writeFileSync(path.join(dir, '0.0'), 'synthetic', { mode: 0o600 });
  const { lstatSync, readdirSync } = fs;
  fs.lstatSync = (target, ...rest) => { if (target === file && fs.existsSync(file)) fs.unlinkSync(file); return lstatSync(target, ...rest); };
  fs.readdirSync = (target, ...rest) => { if (target === dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true }); return readdirSync(target, ...rest); };
  return () => { fs.lstatSync = lstatSync; fs.readdirSync = readdirSync; };
}
test('teardown completes when the live cluster deletes its own files during the preflight walk', async () => {
  const m = fixture(); const restore = vanishing(m);
  try { assert.equal((await require('./runtime.cjs').teardown(m.id)).phase, 'removed'); assert.equal(fs.existsSync(m.root), false); }
  finally { restore(); if (fs.existsSync(m.root)) o.remove(m); }
});
test('only vanished entries are tolerated: the strict removal walk and every tamper refusal stay', () => {
  const m = fixture(); let restore = vanishing(m);
  try { assert.throws(() => o.checkTree(m.root), { code: 'ENOENT' }); } finally { restore(); }
  restore = vanishing(m); try { assert.doesNotThrow(() => o.checkTree(m.root, { live: true })); } finally { restore(); }
  const link = path.join(m.root, 'tmp'); fs.symlinkSync(o.base, link);
  assert.throws(() => o.checkTree(m.root, { live: true }), /ownership verification refused/); assert.ok(fs.existsSync(o.base)); fs.unlinkSync(link);
  assert.throws(() => o.checkTree(path.join(m.root, 'missing'), { live: true }), { code: 'ENOENT' });
  o.remove(m);
});
// ps derives lstart from the kernel's boot time, which moves when the wall clock is stepped. On Linux the identity
// takes the start in clock ticks since boot from /proc/PID/stat instead, which no clock step can move.
test('start ticks are parsed after the last parenthesis, whatever the command name holds', () => {
  const fields = Array.from({ length: 20 }, (_, i) => String(i + 3)); fields[19] = '552573';
  assert.equal(o.procStart('4242 (odd) name (x)) ' + fields.join(' ') + ' 0 0\n'), '552573');
  for (const bad of ['', '4242 no parens S 1', '4242 (n) S 1 2 3']) assert.throws(() => o.procStart(bad), /ownership verification refused/);
});
test('on Linux the identity is the start in ticks since boot plus the command, never the wall-clock start', { skip: process.platform !== 'linux' }, () => {
  const ticks = o.procStart(fs.readFileSync('/proc/self/stat', 'utf8'));
  const command = require('node:child_process').execFileSync('ps', ['-p', String(process.pid), '-o', 'command='], { encoding: 'utf8' }).trim();
  const lstart = require('node:child_process').execFileSync('ps', ['-p', String(process.pid), '-o', 'lstart='], { encoding: 'utf8' }).trim();
  const id = o.identity(process.pid);
  assert.equal(id, 'start-ticks:' + ticks + ' ' + command);
  assert.ok(!id.includes(lstart), 'the wall-clock start must not be part of the identity');
  assert.equal(o.identity(process.pid), id);
});
test('an identity mismatch names the part that differs', () => {
  const id = o.identity(process.pid), cut = id.startsWith('start-ticks:') ? id.indexOf(' ') : 24;
  const start = id.slice(0, cut), command = id.slice(cut + 1);
  assert.equal(o.live({ pid: process.pid, identity: id }), true);
  assert.throws(() => o.live({ pid: process.pid, identity: start + ' synthetic-other-command' }), /^Error: Local process identity mismatch \(command\); resources retained\.$/);
  const otherStart = start.startsWith('start-ticks:') ? 'start-ticks:1' : 'Thu Jan  1 00:00:00 1970';
  assert.throws(() => o.live({ pid: process.pid, identity: otherStart + ' ' + command }), /^Error: Local process identity mismatch \(start\); resources retained\.$/);
  assert.throws(() => o.live({ pid: process.pid, identity: 'foreign' }), /^Error: Local process identity mismatch \(start, command\); resources retained\.$/);
});
