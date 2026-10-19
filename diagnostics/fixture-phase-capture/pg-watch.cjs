const { createRequire } = require('node:module');
const { readFileSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { performance } = require('node:perf_hooks');
const { emitter, safeCode } = require('./trace.cjs');
const activitySql = `SELECT pid, backend_type, state, wait_event_type, wait_event,
  EXTRACT(epoch FROM (clock_timestamp()-query_start))*1000::double precision AS query_age_ms,
  pg_blocking_pids(pid) AS blockers,
  CASE WHEN query ~ '^CREATE DATABASE' THEN 'database-create' WHEN query ~ '^DROP DATABASE' THEN 'database-drop'
    WHEN query LIKE '%pg_advisory_lock%' THEN 'advisory-lock' WHEN query ~ '^COMMIT' THEN 'commit'
    WHEN query ~ '^BEGIN' THEN 'begin' WHEN query ~ '^DO' THEN 'role-or-migration-do'
    WHEN query ~ '^INSERT INTO schema_migrations' THEN 'migration-record' ELSE 'other' END AS phase
  FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND (backend_type <> 'client backend' OR state <> 'idle')`;
const countersSql = 'SELECT checkpoints_timed,checkpoints_req,checkpoint_write_time,checkpoint_sync_time,buffers_checkpoint FROM pg_stat_bgwriter';
const number = value => value !== null && Number.isFinite(Number(value)) ? Number(value) : null;
const word = value => typeof value === 'string' && /^[a-zA-Z0-9_ -]{1,64}$/.test(value) ? value : null;
function sampleRow(row) {
  return { backendPid: number(row.pid), backendType: word(row.backend_type), state: word(row.state), waitClass: word(row.wait_event_type),
    wait: word(row.wait_event), queryAgeMs: number(row.query_age_ms), blockers: (row.blockers ?? []).filter(value => Number.isSafeInteger(value) && value > 0), phase: word(row.phase) };
}
function numericFile(file) {
  try { return Object.fromEntries(readFileSync(file, 'utf8').trim().split('\n').filter(line => /^[a-z_]+ \d+$/.test(line)).map(line => { const [key, value] = line.split(' '); return [key, Number(value)]; })); }
  catch { return null; }
}
async function watch({ client, emit, ready = () => {}, shouldStop = () => false, delay = ms => new Promise(done => setTimeout(done, ms)) }) {
  let samples = 0;
  try {
    const start = performance.now(); await client.connect(); emit({ event: 'connected', ms: performance.now() - start }); ready();
    while (!shouldStop()) {
      const began = performance.now(), { rows } = await client.query(activitySql);
      const waits = rows.map(sampleRow).filter(row => row.queryAgeMs > 100 || row.blockers.length || row.waitClass === 'Lock');
      if (waits.length || samples % 4 === 0) {
        const counters = (await client.query(countersSql)).rows[0];
        emit({ event: 'sample', waits, bgwriter: Object.fromEntries(['checkpoints_timed', 'checkpoints_req', 'checkpoint_write_time', 'checkpoint_sync_time', 'buffers_checkpoint'].map(key => [key, number(counters[key])])),
          queryMs: performance.now() - began, cpu: numericFile('/sys/fs/cgroup/cpu.stat'), memoryEvents: numericFile('/sys/fs/cgroup/memory.events') });
      }
      samples++; await delay(250);
    }
    emit({ event: 'stopped', samples });
  } finally { await client.end(); }
}
module.exports = { watch, sampleRow, activitySql, countersSql };
if (require.main === module) {
  const req = createRequire(join(resolve(__dirname, '../..'), 'apps/backend/package.json'));
  const { Client } = req('pg'), emit = emitter('pg-watch.jsonl', process.env.FIXTURE_CAPTURE_DIR, true);
  const client = new Client({ connectionString: process.env.TEST_DATABASE_URL, application_name: 'fixture-phase-monitor', statement_timeout: 1000, connectionTimeoutMillis: 5000 });
  let stopping = false;
  const stop = () => { stopping = true; };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  watch({ client, emit, shouldStop: () => stopping, ready: () => writeFileSync(join(process.env.FIXTURE_CAPTURE_DIR, 'pg-watch-ready'), 'ready\n', { flag: 'wx', mode: 0o600 }) })
    .catch(error => { emit({ event: 'error', code: safeCode(error) }); process.exitCode = 1; });
}
