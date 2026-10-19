const assert = require('node:assert/strict');
const test = require('node:test');
const { watch, sampleRow, activitySql } = require('./pg-watch.cjs');

test('PostgreSQL records retain correlation/wait counters and exclude SQL, values and configuration', async () => {
  const records = [], forbidden = 'FORBIDDEN_DIAGNOSTIC_PAYLOAD';
  let stopped = false, ended = false;
  const client = { connect: async () => {}, end: async () => { ended = true; }, query: async sql => sql === activitySql ? { rows: [
    { pid: 123, backend_type: 'client backend', state: 'active', wait_event_type: 'Lock', wait_event: 'advisory', query_age_ms: '4200', blockers: [456], phase: 'advisory-lock', query: forbidden, password: forbidden },
  ] } : { rows: [{ checkpoints_timed: '1', checkpoints_req: '2', checkpoint_write_time: '3', checkpoint_sync_time: '4', buffers_checkpoint: '5', raw_query: forbidden }] } };
  await watch({ client, emit: row => records.push(row), shouldStop: () => stopped, delay: async () => { stopped = true; } });
  assert.equal(ended, true); assert.equal(records.at(-1).event, 'stopped');
  const row = records.find(value => value.event === 'sample').waits[0];
  assert.equal(row.backendPid, 123); assert.deepEqual(row.blockers, [456]); assert.equal(row.queryAgeMs, 4200);
  assert.ok(!JSON.stringify(records).includes(forbidden));
});

test('connection/query failures retain their exact error and always close the sampler connection', async () => {
  for (const stage of ['connect', 'query']) {
    const failure = new Error('synthetic refusal'); let closed = false;
    const client = { connect: async () => { if (stage === 'connect') throw failure; }, query: async () => { throw failure; }, end: async () => { closed = true; } };
    await assert.rejects(watch({ client, emit: () => {} }), error => error === failure);
    assert.equal(closed, true);
  }
});

test('non-finite counters and malformed extra fields do not become misleading numeric evidence', () => {
  const row = sampleRow({ pid: null, query_age_ms: 'Infinity', blockers: [123, 'bad', -1], wait_event: 'bad\nvalue', phase: 'other' });
  assert.equal(row.backendPid, null); assert.equal(row.queryAgeMs, null); assert.equal(row.wait, null); assert.deepEqual(row.blockers, [123]);
});
