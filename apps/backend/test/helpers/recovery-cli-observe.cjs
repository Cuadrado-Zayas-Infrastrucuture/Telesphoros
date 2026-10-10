/* eslint-disable @typescript-eslint/no-require-imports -- Node CommonJS preload observes compiled CommonJS exports before CLI entry. */
/* global require, process, __dirname */
// Test-only preload for the BUILT CLI. Observes real work; never substitutes a dump, restore, encryption or provider call.
const { performance } = require('node:perf_hooks');
const { statSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { Client } = require('pg');
const dbRoot = join(__dirname, '../../dist/db');
const events = [];
let restoredAt;

function wrap(moduleName, method, label, facts = () => ({})) {
  const module = require(join(dbRoot, moduleName));
  const original = module[method];
  module[method] = async (...args) => {
    const start = performance.now();
    const before = facts(args);
    let ok = false;
    try { const result = await original(...args); ok = true; return result; }
    finally { events.push({ phase: label, seconds: (performance.now() - start) / 1000, ok, ...before }); }
  };
}

wrap('backup-crypto', 'encryptFile', 'encrypt', args => ({ plaintextDumpBytes: statSync(args[0]).size }));
wrap('backup-crypto', 'decryptFile', 'decrypt', args => ({ encryptedArchiveBytes: statSync(args[0]).size }));
wrap('offsite', 'uploadBackup', 'upload', args => ({ encryptedArchiveBytes: args[1].dump.bytes, manifestBytes: statSync(join(args[0], 'manifest.json')).size }));
wrap('offsite', 'downloadBackup', 'download');
const pg = require(join(dbRoot, 'pg-process'));
const originalRun = pg.run;
pg.run = async (command, args, env) => {
  const start = performance.now();
  await originalRun(command, args, env);
  if (command === 'pg_dump' || command === 'pg_restore') {
    const bytes = command === 'pg_dump' ? statSync(args.find(a => a.startsWith('--file=')).slice(7)).size : statSync(args[args.length - 1]).size;
    events.push({ phase: command, seconds: (performance.now() - start) / 1000, ok: true, plaintextDumpBytes: bytes });
  }
  if (command === 'pg_restore') {
    const fault = process.env.RECOVERY_REHEARSAL_FAULT;
    if (fault) {
      if (env.PGHOST !== '127.0.0.1' || !/^(restore_check_|recovery_cli_)/.test(env.PGDATABASE)) throw new Error('Refused nonfixture recovery fault.');
      const c = new Client({ host: env.PGHOST, port: Number(env.PGPORT), user: env.PGUSER, password: env.PGPASSWORD, database: env.PGDATABASE });
      await c.connect();
      try {
        if (fault === 'rls') await c.query('ALTER TABLE patients DISABLE ROW LEVEL SECURITY');
        else if (fault === 'acl') await c.query('REVOKE SELECT ON patients FROM telesphoros_app');
        else throw new Error('Unknown recovery fixture fault.');
      } finally { await c.end(); }
    }
    restoredAt = performance.now();
  }
};
const restore = require(join(dbRoot, 'restore'));
const originalRestore = restore.restoreAndVerify;
restore.restoreAndVerify = async (...args) => {
  const result = await originalRestore(...args);
  if (restoredAt !== undefined) events.push({ phase: 'restore-verification-and-temp-cleanup', seconds: (performance.now() - restoredAt) / 1000, ok: result.ok });
  return result;
};
process.once('exit', () => {
  if (process.env.RECOVERY_REHEARSAL_OBSERVATIONS) writeFileSync(process.env.RECOVERY_REHEARSAL_OBSERVATIONS, JSON.stringify(events), { mode: 0o600 });
});
