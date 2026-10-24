import { createServer, type AddressInfo, type Socket } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { JobQueue } from '@telesphoros/jobs';
import { WORKER_POOL_LIMITS } from '../src/pool-limits';
import { createFixture, type Fixture } from './support';

// The limits on the worker's pool, against a real PostgreSQL and the worker's own login (what main.ts builds, minus the TLS setting the test server does not use).
let f: Fixture;
let pool: Pool;

beforeAll(async () => {
  f = await createFixture();
  pool = new Pool({ connectionString: f.db.workerUrl, ...WORKER_POOL_LIMITS, max: 3 });
  pool.on('error', () => undefined);
});
afterAll(async () => {
  await pool?.end();
  await f?.close();
});

describe('the worker pool limits', () => {
  it('are applied to every connection the server sees', async () => {
    const rows = (await pool.query(`SELECT current_setting('statement_timeout') AS s, current_setting('idle_in_transaction_session_timeout') AS i`)).rows[0];
    expect(rows).toEqual({ s: '10s', i: '10s' });
  });

  it('cancel a statement that runs past the limit, with the server timeout code, and the connection stays usable', async () => {
    const started = Date.now();
    await expect(pool.query('SELECT pg_sleep(30)')).rejects.toMatchObject({ code: '57014' });
    expect(Date.now() - started).toBeLessThan(15_000);
    expect((await pool.query('SELECT 1 AS one')).rows[0].one).toBe(1); // control: the pool still works afterwards
  }, 30_000);

  it('end a transaction left idle past the limit, and the next use of the pool is a fresh connection', async () => {
    const client = await pool.connect();
    client.on('error', () => undefined);
    await client.query('BEGIN');
    await new Promise((resolve) => setTimeout(resolve, 11_500));
    await expect(client.query('SELECT 1')).rejects.toBeDefined(); // the server has terminated the session
    client.release(true);
    expect((await pool.query('SELECT 1 AS one')).rows[0].one).toBe(1);
  }, 30_000);

  it('fail a connection attempt fast when the server accepts the socket but never answers, instead of waiting for ever', async () => {
    // A listener that accepts and stays silent: a refused connection would fail at once and prove nothing about the timeout.
    const sockets: Socket[] = [];
    const silent = createServer((socket) => void sockets.push(socket));
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    const dead = new Pool({ host: '127.0.0.1', port: (silent.address() as AddressInfo).port, user: 'x', database: 'x', ...WORKER_POOL_LIMITS, max: 1 });
    dead.on('error', () => undefined);
    try {
      const started = Date.now();
      await expect(dead.query('SELECT 1')).rejects.toThrow(/timeout/i);
      const took = Date.now() - started;
      expect(took).toBeGreaterThanOrEqual(WORKER_POOL_LIMITS.connectionTimeoutMillis - 100);
      expect(took).toBeLessThan(WORKER_POOL_LIMITS.connectionTimeoutMillis + 1_500);
    } finally {
      await dead.end().catch(() => undefined);
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => silent.close(resolve));
    }
  }, 15_000);

  it('leave the queue working: a claim through the limited pool succeeds when there is nothing to claim', async () => {
    const queue = new JobQueue(pool);
    await expect(queue.claim('limits-test', { types: ['uploads.sweep'], batch: 1, tenantCap: 1, leaseSeconds: 60 })).resolves.toEqual([]);
  });
});
