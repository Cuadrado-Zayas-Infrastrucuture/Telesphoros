import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { startHealthServer } from './health';
import type { Runner } from './runner';

const fake = (state: { lastLoopAt: number; activeCount: number; isStopping: boolean }) => state as unknown as Runner;

describe('health server', () => {
  it('is live while the loop goes round, not ready once stopping, and stale when the loop stops', async () => {
    // A wide window, and staleness set by moving lastLoopAt far back: the result never depends on how long the test itself takes
    // (a 200 ms window failed at 357 ms when every package's tests ran at once).
    const STALE_AFTER_MS = 60_000;
    const state = { lastLoopAt: Date.now(), activeCount: 2, isStopping: false };
    const server = await startHealthServer(fake(state), { host: '127.0.0.1', port: 0, staleAfterMs: STALE_AFTER_MS });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const live = await fetch(`${base}/livez`);
      expect(live.status).toBe(200);
      expect(await live.json()).toEqual({ status: 'ok', running: 2, stopping: false });
      expect((await fetch(`${base}/readyz`)).status).toBe(200);
      state.isStopping = true;
      expect((await fetch(`${base}/readyz`)).status).toBe(503);
      expect((await fetch(`${base}/livez`)).status).toBe(200);
      state.lastLoopAt = Date.now() - 2 * STALE_AFTER_MS;
      expect((await fetch(`${base}/livez`)).status).toBe(503);
      expect((await fetch(`${base}/other`)).status).toBe(404);
      expect((await fetch(`${base}/livez`, { method: 'POST' })).status).toBe(404);
    } finally {
      server.close();
    }
  });
  it('never started means not live', async () => {
    const server = await startHealthServer(fake({ lastLoopAt: 0, activeCount: 0, isStopping: false }), { host: '127.0.0.1', port: 0, staleAfterMs: 60_000 });
    try {
      expect((await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/livez`)).status).toBe(503);
    } finally {
      server.close();
    }
  });
});
