import { EventEmitter } from 'node:events';
import type { Server } from 'node:http';
import { Controller, Get, Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { installGracefulShutdown } from './graceful-shutdown';

// A stand-in for the database pool: it works until the module is destroyed, as Database's does (`pool.end()` in onModuleDestroy).
const events: string[] = [];
@Injectable()
class FakePool implements OnModuleDestroy {
  ended = false;
  query() {
    if (this.ended) throw new Error('pool ended');
    return 'rows';
  }
  onModuleDestroy() {
    this.ended = true;
    events.push('pool-ended');
  }
}

let hangMs = 300;
@Controller()
class SlowController {
  constructor(private readonly pool: FakePool) {}
  @Get('slow')
  async slow() {
    await new Promise((resolve) => setTimeout(resolve, hangMs));
    const rows = this.pool.query(); // a handler's last act is a query, as most are
    events.push('request-done');
    return { rows };
  }
  @Get('quick')
  quick() {
    return { ok: true };
  }
}

async function start(): Promise<{ app: NestExpressApplication; base: string; server: Server }> {
  const moduleRef = await Test.createTestingModule({ controllers: [SlowController], providers: [FakePool] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  await app.listen(0, '127.0.0.1');
  const server = app.getHttpServer() as Server;
  return { app, base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, server };
}

const get = (url: string) => fetch(url, { headers: { connection: 'close' } }).then(async (r) => ({ status: r.status, body: await r.text() }), (error: Error) => ({ status: 0, body: error.message }));
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => { events.length = 0; hangMs = 300; });

describe('what closing the app does to a request in flight', () => {
  it('(control) app.close() alone ends the pool under a running request, so the request fails', async () => {
    const { app, base } = await start();
    const inflight = get(`${base}/slow`);
    await pause(60);
    await app.close();
    expect((await inflight).status).toBe(500);
    expect(events).toEqual(['pool-ended']);
  });
});

describe('installGracefulShutdown', () => {
  function install(app: NestExpressApplication, server: Server, options: { pauseMs?: number; drainMs?: number; deadlineMs?: number } = {}) {
    const target = new EventEmitter();
    const exits: number[] = [];
    const lines: string[] = [];
    installGracefulShutdown(app, server, { pauseMs: 0, drainMs: 2000, deadlineMs: 5000, ...options, target, exit: (code) => exits.push(code), write: (line) => lines.push(line) });
    return { target, exits, lines };
  }
  const settled = async (exits: number[]) => { for (let i = 0; i < 200 && exits.length === 0; i++) await pause(20); };

  it('lets a request in flight finish, and ends the pool only after it', async () => {
    const { app, base, server } = await start();
    const { target, exits } = install(app, server);
    const inflight = get(`${base}/slow`);
    await pause(60);
    target.emit('SIGTERM');
    const response = await inflight;
    await settled(exits);
    expect(response.status).toBe(200);
    expect(events).toEqual(['request-done', 'pool-ended']);
    expect(exits).toEqual([0]);
  });

  it('keeps serving during the pause, then stops accepting', async () => {
    const { app, base, server } = await start();
    const { target, exits } = install(app, server, { pauseMs: 300 });
    target.emit('SIGTERM');
    await pause(80);
    expect((await get(`${base}/quick`)).status).toBe(200); // a request the load balancer sent just before it noticed
    await settled(exits);
    expect((await get(`${base}/quick`)).status).toBe(0); // the listener is gone
    expect(exits).toEqual([0]);
  });

  it('cuts a request that outlasts the drain cap, and still closes cleanly', async () => {
    hangMs = 5000;
    const { app, base, server } = await start();
    const { target, exits, lines } = install(app, server, { drainMs: 150 });
    const inflight = get(`${base}/slow`);
    await pause(60);
    target.emit('SIGTERM');
    await settled(exits);
    expect((await inflight).status).toBe(0);
    expect(exits).toEqual([0]);
    expect(lines.map((l) => (JSON.parse(l) as { event: string }).event)).toContain('shutdown-drain-cut');
  });

  it('ignores a second signal', async () => {
    const { app, base, server } = await start();
    const { target, exits } = install(app, server);
    const inflight = get(`${base}/slow`);
    await pause(60);
    target.emit('SIGTERM');
    target.emit('SIGINT');
    await inflight;
    await settled(exits);
    await pause(50);
    expect(exits).toEqual([0]);
    expect(events.filter((e) => e === 'pool-ended')).toHaveLength(1);
  });

  it('exits 1 at the deadline when the close itself hangs', async () => {
    const stuck = { close: () => new Promise<void>(() => undefined) } as unknown as NestExpressApplication;
    const target = new EventEmitter();
    const exits: number[] = [];
    const lines: string[] = [];
    installGracefulShutdown(stuck, new (await import('node:http')).Server(), { pauseMs: 0, drainMs: 50, deadlineMs: 200, target, exit: (code) => exits.push(code), write: (line) => lines.push(line) });
    target.emit('SIGTERM');
    await settled(exits);
    expect(exits).toEqual([1]);
    expect(lines.map((l) => (JSON.parse(l) as { event: string }).event)).toContain('shutdown-forced');
  });

  it('writes lines that name the event and the signal and nothing else', async () => {
    const { app, server } = await start();
    const { target, exits, lines } = install(app, server);
    target.emit('SIGTERM');
    await settled(exits);
    const first = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(first).toMatchObject({ level: 'info', service: 'api', event: 'shutdown-requested', reason: 'SIGTERM' });
    expect(Object.keys(first).sort()).toEqual(['event', 'level', 'reason', 'service', 'time']);
  });
});
