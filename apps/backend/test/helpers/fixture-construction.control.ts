// Explicit real-service controls; .control.ts is outside normal profile discovery.
import { Client, Pool } from 'pg';
import { Test } from '@nestjs/testing';
import { createEphemeralDatabase, withAdmin } from './database';
import { createTestApp } from './app';
import { disposeFixtures, onceFixtureCleanup } from './fixture-cleanup';

const base = process.env.TEST_DATABASE_URL!;
const inventory = () => withAdmin(base, async c => (await c.query("SELECT datname FROM pg_database WHERE left(datname, 5)=$1 ORDER BY datname", ['test_'])).rows.map(r => r.datname));
let protectedDatabase: Awaited<ReturnType<typeof createEphemeralDatabase>>;
let before: string[];
beforeAll(async () => { protectedDatabase = await createEphemeralDatabase({ migrate: false }); before = await inventory(); });
afterEach(async () => {
  jest.restoreAllMocks(); expect(await inventory()).toEqual(before);
  const sessions = await withAdmin(base, async c => (await c.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE left(datname, 5)=$1", ['test_'])).rows[0].n);
  expect(sessions).toBe(0);
});
afterAll(async () => { await protectedDatabase?.drop(); });

it('closes an already-connected migrator and drops its database when connect rejects', async () => {
  const connect = Client.prototype.connect;
  let injected = false;
  jest.spyOn(Client.prototype, 'connect').mockImplementation(async function (this: Client) {
    await Reflect.apply(connect, this, []);
    if (!injected && /^test_/.test((this as unknown as { database: string }).database)) {
      injected = true; throw new Error('synthetic migrator connect rejection');
    }
  });
  await expect(createEphemeralDatabase()).rejects.toThrow('synthetic migrator connect rejection');
  expect(injected).toBe(true);
});

it('drops the database when the real migrator rejects before returning a handle', async () => {
  const query = Client.prototype.query;
  let injected = false;
  jest.spyOn(Client.prototype, 'query').mockImplementation(function (this: Client, ...args: unknown[]) {
    if (!injected && args[0] === 'SELECT pg_advisory_lock($1)' && (args[1] as number[])?.[0] === 7262001) {
      injected = true; return Promise.reject(new Error('synthetic migration rejection'));
    }
    return Reflect.apply(query, this, args);
  } as typeof query);
  await expect(createEphemeralDatabase()).rejects.toThrow('synthetic migration rejection');
  expect(injected).toBe(true);
});

it('unwinds an owned database and admin pool when module compilation rejects', async () => {
  const create = Test.createTestingModule;
  const end = jest.spyOn(Pool.prototype, 'end');
  jest.spyOn(Test, 'createTestingModule').mockImplementation((...args) => {
    const builder = create.apply(Test, args);
    jest.spyOn(builder, 'compile').mockRejectedValue(new Error('synthetic compile rejection'));
    return builder;
  });
  await expect(createTestApp()).rejects.toThrow('synthetic compile rejection');
  expect(end).toHaveBeenCalled();
});

it('closes a live listener and all database resources when listen rejects after binding', async () => {
  const create = Test.createTestingModule;
  let server: { listening: boolean } | undefined;
  jest.spyOn(Test, 'createTestingModule').mockImplementation((...args) => {
    const builder = create.apply(Test, args), compile = builder.compile.bind(builder);
    jest.spyOn(builder, 'compile').mockImplementation(async (...params) => {
      const module = await compile(...params), createApp = module.createNestApplication.bind(module);
      jest.spyOn(module, 'createNestApplication').mockImplementation((...options) => {
        const app = createApp(...options), listen = app.listen.bind(app);
        jest.spyOn(app, 'listen').mockImplementation(async (...listenArgs) => {
          await listen(...listenArgs); server = app.getHttpServer(); throw new Error('synthetic listen rejection');
        });
        return app;
      });
      return module;
    });
    return builder;
  });
  await expect(createTestApp()).rejects.toThrow('synthetic listen rejection');
  expect(server).toBeDefined(); expect(server!.listening).toBe(false);
});

it('cancellation after compile closes the module and never starts a listener', async () => {
  const controller = new AbortController(), create = Test.createTestingModule;
  let createApp: jest.SpyInstance | undefined;
  jest.spyOn(Test, 'createTestingModule').mockImplementation((...args) => {
    const builder = create.apply(Test, args), compile = builder.compile.bind(builder);
    jest.spyOn(builder, 'compile').mockImplementation(async (...params) => {
      const module = await compile(...params);
      createApp = jest.spyOn(module, 'createNestApplication');
      controller.abort(new Error('synthetic cancelled fixture')); return module;
    });
    return builder;
  });
  await expect(createTestApp({ signal: controller.signal })).rejects.toThrow('synthetic cancelled fixture');
  expect(createApp).not.toHaveBeenCalled();
});

it('concurrent close callers share cleanup and a failed app close does not skip database disposal', async () => {
  const create = Test.createTestingModule;
  jest.spyOn(Test, 'createTestingModule').mockImplementation((...args) => {
    const builder = create.apply(Test, args), compile = builder.compile.bind(builder);
    jest.spyOn(builder, 'compile').mockImplementation(async (...params) => {
      const module = await compile(...params), createApp = module.createNestApplication.bind(module);
      jest.spyOn(module, 'createNestApplication').mockImplementation((...options) => {
        const app = createApp(...options), close = app.close.bind(app);
        jest.spyOn(app, 'close').mockImplementation(async () => { await close(); throw new Error('synthetic close rejection'); });
        return app;
      });
      return module;
    });
    return builder;
  });
  const app = await createTestApp(); const first = app.close(), second = app.close();
  expect(first).toBe(second);
  await expect(first).rejects.toThrow('synthetic close rejection');
  await expect(second).rejects.toThrow('synthetic close rejection');
});

it('attempts all disposals and retains original and cleanup failures exactly once', async () => {
  const original = new Error('synthetic original'), cleanup = new Error('synthetic cleanup');
  const calls: string[] = [];
  const dispose = onceFixtureCleanup(() => disposeFixtures([
    async () => { calls.push('first'); throw cleanup; }, async () => { calls.push('last'); },
  ], [original]));
  const first = dispose(), second = dispose(); expect(first).toBe(second);
  await expect(first).rejects.toMatchObject({ errors: [original, cleanup] });
  expect(calls).toEqual(['first', 'last']);
});

it('retains both work and client-end errors while still closing the real connection', async () => {
  const end = Client.prototype.end;
  jest.spyOn(Client.prototype, 'end').mockImplementation(async function (this: Client) {
    await Reflect.apply(end, this, []); throw new Error('synthetic end rejection');
  });
  await expect(withAdmin(base, async () => { throw new Error('synthetic work rejection'); })).rejects.toMatchObject({
    errors: [expect.objectContaining({ message: 'synthetic work rejection' }), expect.objectContaining({ message: 'synthetic end rejection' })],
  });
});
