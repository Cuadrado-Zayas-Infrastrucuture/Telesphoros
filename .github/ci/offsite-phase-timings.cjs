// Diagnostic-only Jest setup. No production module imports this observer.
const { AsyncLocalStorage } = require('node:async_hooks');
const { createHash } = require('node:crypto');
const { closeSync, lstatSync, mkdirSync, openSync, readFileSync, writeSync } = require('node:fs');
const { isAbsolute, join, resolve } = require('node:path');
const { performance } = require('node:perf_hooks');

function recorder(directory, metadata = {}) {
  if (!isAbsolute(directory)) throw new Error('Diagnostic directory must be absolute.');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error('Invalid diagnostic directory.');
  const fd = openSync(join(directory, 'offsite-phases.jsonl'), 'wx', 0o600);
  const context = new AsyncLocalStorage();
  let sequence = 0; let test = null; let closed = false;
  const emit = value => writeSync(fd, JSON.stringify({ ...value, wallMs: Date.now(), monotonicMs: performance.now() }) + '\n');
  emit({ event: 'metadata', format: 1, ...metadata });
  const timed = (phase, fn, receiver, args, decorate) => {
    const parent = context.getStore();
    const scope = { span: ++sequence, parent: parent?.span ?? null, test: parent?.test ?? test };
    const started = performance.now();
    emit({ event: 'start', phase, ...scope });
    const finish = ok => emit({ event: 'end', phase, ...scope, ok, durationMs: performance.now() - started });
    let value;
    try { value = context.run(scope, () => Reflect.apply(fn, receiver, args)); }
    catch (error) { finish(false); throw error; }
    // Return the observed chain with the same value/rejection. A side listener on
    // the original promise would hide an unhandled rejection if a caller drops it.
    if (value && typeof value.then === 'function') {
      return value.then(result => { decorate?.(result); finish(true); return result; }, error => { finish(false); throw error; });
    } else { decorate?.(value); finish(true); }
    return value;
  };
  return {
    timed,
    begin(index) { test = index; emit({ event: 'test-start', test }); },
    end() { emit({ event: 'test-end', test }); test = null; },
    close(code = null) { if (!closed) { emit({ event: 'process-exit', code }); closeSync(fd); closed = true; } },
  };
}

function cloneExports(actual, replacements) {
  const descriptors = Object.getOwnPropertyDescriptors(actual);
  for (const [key, value] of Object.entries(replacements)) descriptors[key] = { value, enumerable: true, configurable: true, writable: true };
  return Object.defineProperties(Object.create(Object.getPrototypeOf(actual)), descriptors);
}

function install(api, env = process.env) {
  if (!api.expect.getState().testPath.endsWith('/test/db/offsite-restore.pg-spec.ts')) return null;
  const backend = resolve(__dirname, '../../apps/backend');
  const sha = value => /^[a-f0-9]{40}$/.test(value ?? '') ? value : null;
  const number = value => /^[1-9][0-9]*$/.test(value ?? '') ? value : null;
  const hashes = Object.fromEntries(['test/health.e2e-spec.ts', 'test/db/offsite-restore.pg-spec.ts', 'src/db/restore.ts', 'src/db/offsite.ts']
    .map(file => [file, createHash('sha256').update(readFileSync(join(backend, file))).digest('hex')]));
  const trace = recorder(env.OFFSITE_PHASE_TRACE_DIR, { node: process.versions.node, platform: process.platform, architecture: process.arch,
    outcomeMeaning: 'returned-or-fulfilled', runId: number(env.GITHUB_RUN_ID), attempt: number(env.GITHUB_RUN_ATTEMPT), checkout: sha(env.GITHUB_SHA), headSha: sha(env.SERVICE_HEAD_SHA), sources: hashes });
  const resource = (phase, key) => value => {
    const original = value[key];
    value[key] = function (...args) { return trace.timed(phase, original, this, args); };
  };
  function wrap(relative, operations) {
    const file = join(backend, relative);
    api.jest.doMock(file, () => {
      const actual = api.jest.requireActual(file); const replacements = {};
      for (const [name, [phase, decorate]] of Object.entries(operations)) {
        const original = actual[name];
        if (typeof original !== 'function') throw new Error('Missing diagnostic operation.');
        replacements[name] = function (...args) {
          const label = typeof phase === 'function' ? phase(args) : phase;
          return trace.timed(label, original, this, args, decorate);
        };
      }
      return cloneExports(actual, replacements);
    });
  }
  wrap('test/helpers/database.ts', { createEphemeralDatabase: ['fixture-create'] });
  wrap('test/helpers/provider-gateway.ts', { startGateway: ['gateway-start', resource('gateway-close', 'close')] });
  wrap('test/helpers/offsite-fixtures.ts', { newBucket: ['bucket-create'], cleanupScratch: ['fixture-scratch-cleanup'] });
  wrap('src/db/backup.ts', { createBackup: ['backup'], sha256File: ['file-checksum'] });
  wrap('src/db/backup-crypto.ts', { generateKeyFile: ['key-generate'], readKeyFile: ['key-read'], encryptFile: ['encrypt'], decryptFile: ['decrypt'] });
  wrap('src/db/offsite.ts', { uploadBackup: ['upload'], downloadBackup: ['download-complete'] });
  wrap('src/db/restore-remote.ts', { restoreFromRemote: ['remote-restore'] });
  wrap('src/db/restore.ts', { restoreAndVerify: ['restore-and-verify'] });
  wrap('src/db/pg-process.ts', { run: [args => args[0] === 'pg_restore' ? 'pg-restore' : args[0] === 'pg_dump' ? 'pg-dump' : 'pg-command'] });
  wrap('src/db/cleanup.ts', { makeTempDir: ['temp-create', resource('temp-dispose', 'dispose')] });
  api.jest.doMock('pg', () => {
    const actual = api.jest.requireActual('pg');
    class ObservedClient extends actual.Client {
      connect(...args) {
        if (args.some(value => typeof value === 'function')) return super.connect(...args);
        return trace.timed('pg-connect', actual.Client.prototype.connect, this, args);
      }
      query(...args) {
        if (args.some(value => typeof value === 'function')) return super.query(...args);
        const text = typeof args[0] === 'string' ? args[0] : args[0]?.text;
        const phase = /^CREATE DATABASE\b/i.test(text ?? '') ? 'pg-create-database' : /^DROP DATABASE\b/i.test(text ?? '') ? 'pg-drop-database' : 'pg-query';
        return trace.timed(phase, actual.Client.prototype.query, this, args);
      }
      end(...args) {
        if (args.some(value => typeof value === 'function')) return super.end(...args);
        return trace.timed('pg-end', actual.Client.prototype.end, this, args);
      }
    }
    return cloneExports(actual, { Client: ObservedClient });
  });
  let index = 0;
  api.beforeEach(() => trace.begin(++index));
  api.afterEach(() => trace.end());
  // An open regular-file descriptor does not keep Jest alive. Close after fixture cleanup,
  // not in afterAll: this setup's afterAll would precede the suite's resource shutdown.
  process.once('exit', code => trace.close(code));
  return trace;
}

module.exports = { recorder, cloneExports, install };
if (typeof jest !== 'undefined' && process.env.OFFSITE_PHASE_TRACE_DIR) install({ jest, expect, beforeEach, afterEach });
