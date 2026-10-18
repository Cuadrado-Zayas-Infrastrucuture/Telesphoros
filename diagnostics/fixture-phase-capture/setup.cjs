const { AsyncLocalStorage } = require('node:async_hooks');
const { createRequire } = require('node:module');
const { readFileSync, readdirSync } = require('node:fs');
const { join, relative, resolve } = require('node:path');
const { performance, monitorEventLoopDelay, PerformanceObserver } = require('node:perf_hooks');
const { setTimeout, clearTimeout } = require('node:timers');
const v8 = require('node:v8');
const { emitter } = require('./trace.cjs');
const { cloneExports } = require('../../.github/ci/offsite-phase-timings.cjs');
const backend = resolve(__dirname, '../../apps/backend');

function classify(text, values, migrations) {
  return migrations.get(text) ?? (/pg_advisory_lock/.test(text) ? (values?.[0] === 4242 ? 'role-lock' : 'migration-lock')
    : /pg_advisory_unlock/.test(text) ? 'unlock' : /^CREATE DATABASE\b/.test(text) ? 'database-create'
    : /^DROP DATABASE\b/.test(text) ? 'database-drop' : /^DO\b/.test(text) ? 'roles'
    : /^BEGIN$/.test(text) ? 'begin' : /^COMMIT$/.test(text) ? 'commit'
    : /^INSERT INTO schema_migrations/.test(text) ? 'migration-record'
    : /^SELECT.*schema_migrations/.test(text) ? 'migration-history' : 'other-sql');
}

// The observed chain retains rejection identity and unhandled-rejection behavior.
function observe(fn, receiver, args, finish) {
  let value;
  try { value = Reflect.apply(fn, receiver, args); }
  catch (error) { finish(false); throw error; }
  if (value && typeof value.then === 'function') return value.then(result => { finish(true); return result; }, error => { finish(false); throw error; });
  finish(true); return value;
}

function install(api, options = {}) {
  const file = relative(backend, api.expect.getState().testPath).replaceAll('\\', '/');
  if (!/^(?:src|test)\/[a-zA-Z0-9_./-]+\.(?:spec|pg-spec|s3-spec|e2e-spec)\.ts$/.test(file)) throw new Error('Unexpected capture suite.');
  const output = options.emit ?? emitter('setup.jsonl', process.env.FIXTURE_CAPTURE_DIR, true);
  const emit = record => output({ file, ...record });
  const scope = new AsyncLocalStorage();
  // Fully skipped suites never run afterAll. Start native observers only when a fixture
  // actually begins, so skipped/unit-only suites do not retain idle observer contexts.
  let loop, gc;
  const startMonitors = () => {
    if (loop) return;
    loop = monitorEventLoopDelay({ resolution: 20 }); loop.enable();
    gc = new PerformanceObserver(list => {
      for (const event of list.getEntries()) if (event.duration >= 50) emit({ event: 'gc', durationMs: event.duration, startTime: event.startTime, kind: event.detail.kind });
    });
    gc.observe({ entryTypes: ['gc'] });
  };
  const migrations = options.migrations ?? new Map(readdirSync(join(backend, 'migrations')).filter(name => /^\d{4}_.+\.up\.sql$/.test(name))
    .map(name => [readFileSync(join(backend, 'migrations', name), 'utf8'), 'migration:' + name.slice(0, 4)]));
  const req = createRequire(join(backend, 'package.json'));
  const pgPath = options.pgPath ?? req.resolve('pg');
  let sequence = 0, spanSequence = 0;
  const detailed = file === 'test/db/system-actor.pg-spec.ts';
  const timed = (phase, fn, receiver, args) => {
    const state = scope.getStore();
    if (!state) return Reflect.apply(fn, receiver, args);
    const start = performance.now(), span = ++spanSequence;
    state.active.set(span, { span, phase, start, backendPid: receiver?.processID ?? null });
    if (detailed || phase === 'migrate-up') emit({ event: 'operation-start', id: state.id, span, phase, backendPid: receiver?.processID ?? null });
    return observe(fn, receiver, args, ok => {
      const ms = performance.now() - start;
      state.active.delete(span); state.totals[phase] = (state.totals[phase] ?? 0) + ms; state.counts[phase] = (state.counts[phase] ?? 0) + 1;
      if (detailed || phase === 'migrate-up' || ms > 200) emit({ event: 'operation-end', id: state.id, span, phase, ms, ok, backendPid: receiver?.processID ?? null });
    });
  };
  api.jest.doMock(pgPath, () => {
    const actual = api.jest.requireActual(pgPath);
    for (const [method, label] of [['connect', 'connect'], ['query', null], ['end', 'disconnect']]) {
      const original = actual.Client.prototype[method];
      actual.Client.prototype[method] = function (...args) {
        if (args.some(value => typeof value === 'function')) return Reflect.apply(original, this, args);
        const phase = label ?? classify(typeof args[0] === 'string' ? args[0] : args[0]?.text ?? '', args[1], migrations);
        return timed(phase, original, this, args);
      };
    }
    return actual; // Preserve Client and Pool identity, as in the full local reproduction.
  });
  const migrator = join(backend, 'src/db/migrator.ts');
  api.jest.doMock(migrator, () => {
    const actual = api.jest.requireActual(migrator);
    return cloneExports(actual, { migrateUp: function (...args) { return timed('migrate-up', actual.migrateUp, this, args); } });
  });
  const helper = join(backend, 'test/helpers/database.ts');
  api.jest.doMock(helper, () => {
    const actual = api.jest.requireActual(helper);
    return cloneExports(actual, { createEphemeralDatabase: function (...args) {
      startMonitors();
      const state = { id: ++sequence, active: new Map(), totals: {}, counts: {} };
      const start = performance.now(), cpu = process.cpuUsage();
      emit({ event: 'fixture-start', id: state.id, memory: process.memoryUsage() });
      const probe = setTimeout(() => emit({ event: 'fixture-four-seconds', id: state.id,
        active: [...state.active.values()].map(value => ({ ...value, ageMs: performance.now() - value.start })),
        totals: state.totals, counts: state.counts, loopMaxMs: loop.max / 1e6, memory: process.memoryUsage(), cpu: process.cpuUsage(cpu) }), 4000);
      probe.unref();
      return observe(() => scope.run(state, () => Reflect.apply(actual.createEphemeralDatabase, this, args)), null, [], ok => {
        clearTimeout(probe);
        emit({ event: 'fixture-end', id: state.id, ok, ms: performance.now() - start, totals: state.totals, counts: state.counts,
          cpu: process.cpuUsage(cpu), loopMaxMs: loop.max / 1e6, memory: process.memoryUsage() });
      });
    } });
  });
  emit({ event: 'suite-open', node: process.versions.node, arch: process.arch, heapLimit: v8.getHeapStatistics().heap_size_limit,
    memory: process.memoryUsage(), cpu: process.cpuUsage() });
  const close = () => {
    emit({ event: 'observer-hooks-ending', memory: process.memoryUsage(), cpu: process.cpuUsage(), loopMaxMs: loop ? loop.max / 1e6 : null });
    loop?.disable(); gc?.disconnect();
    // Keep append-based recording available for a late fixture completion after a timed-out hook.
  };
  api.afterAll(close);
  return { close };
}

module.exports = { install, observe, classify };
if (typeof jest !== 'undefined') install({ jest, expect, afterAll });
