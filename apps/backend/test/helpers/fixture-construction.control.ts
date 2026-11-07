// Explicit real-service controls; .control.ts is outside normal profile discovery.
import { Client, Pool } from 'pg';
import { Test } from '@nestjs/testing';
import { createEphemeralDatabase, ensureMigratedTemplate, migratedTemplateName, withAdmin } from './database';
import { createTestApp } from './app';
import { disposeFixtures, onceFixtureCleanup } from './fixture-cleanup';

const base = process.env.TEST_DATABASE_URL!;
const inventory = () =>
  withAdmin(base, async (c) =>
    (await c.query('SELECT datname FROM pg_database WHERE starts_with(datname, $1) OR starts_with(datname, $2) ORDER BY datname', ['test_', 'tplbuild_'])).rows.map(
      (r) => r.datname,
    ),
  );
let protectedDatabase: Awaited<ReturnType<typeof createEphemeralDatabase>>;
let before: string[];
beforeAll(async () => {
  protectedDatabase = await createEphemeralDatabase({ migrate: false });
  before = await inventory();
});
afterEach(async () => {
  jest.restoreAllMocks();
  expect(await inventory()).toEqual(before);
  const sessions = await withAdmin(
    base,
    async (c) => (await c.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE starts_with(datname, $1) OR starts_with(datname, $2)', ['test_', 'tplbuild_'])).rows[0].n,
  );
  expect(sessions).toBe(0);
});
afterAll(async () => {
  await protectedDatabase?.drop();
});

// Run these controls alone: force a cold template build without touching the unrelated protected fixture.
async function removeTemplate(): Promise<void> {
  await withAdmin(base, async (c) => {
    const template = migratedTemplateName();
    if ((await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [template])).rows.length > 0) {
      await c.query(`ALTER DATABASE ${template} IS_TEMPLATE false`);
      await c.query(`DROP DATABASE ${template} WITH (FORCE)`);
    }
  });
}

it('closes an already-connected template migrator and drops its build when connect rejects', async () => {
  await removeTemplate();
  const connect = Client.prototype.connect;
  let injected = false;
  // eslint-disable-next-line @typescript-eslint/no-misused-promises -- pg types connect's callback overload as void; the real method returns this promise
  jest.spyOn(Client.prototype, 'connect').mockImplementation(async function (this: Client) {
    await Reflect.apply(connect, this, []);
    if (!injected && /^tplbuild_/.test((this as unknown as { database: string }).database)) {
      injected = true;
      throw new Error('synthetic migrator connect rejection');
    }
  });
  await expect(ensureMigratedTemplate()).rejects.toThrow('synthetic migrator connect rejection');
  expect(injected).toBe(true);
});

it('drops the template build when the real migrator rejects before publishing it', async () => {
  await removeTemplate();
  const query = Client.prototype.query;
  let injected = false;
  // eslint-disable-next-line @typescript-eslint/no-misused-promises -- pg types query's callback overloads as void; the real method returns this promise
  jest.spyOn(Client.prototype, 'query').mockImplementation(function (this: Client, ...args: unknown[]) {
    if (!injected && args[0] === 'SELECT pg_advisory_lock($1)' && (args[1] as number[])?.[0] === 7262001) {
      injected = true;
      return Promise.reject(new Error('synthetic migration rejection'));
    }
    return Reflect.apply(query, this, args);
  } as typeof query);
  await expect(ensureMigratedTemplate()).rejects.toThrow('synthetic migration rejection');
  expect(injected).toBe(true);
});

it('drops the renamed database when template publication rejects', async () => {
  await removeTemplate();
  const query = Client.prototype.query;
  let injected = false;
  // eslint-disable-next-line @typescript-eslint/no-misused-promises -- pg types query's callback overloads as void; the real method returns this promise
  jest.spyOn(Client.prototype, 'query').mockImplementation(function (this: Client, ...args: unknown[]) {
    if (args[0] === `ALTER DATABASE ${migratedTemplateName()} WITH IS_TEMPLATE true ALLOW_CONNECTIONS false`) {
      injected = true;
      return Promise.reject(new Error('synthetic template publication rejection'));
    }
    return Reflect.apply(query, this, args);
  } as typeof query);
  await expect(ensureMigratedTemplate()).rejects.toThrow('synthetic template publication rejection');
  expect(injected).toBe(true);
  expect(await withAdmin(base, async (c) => (await c.query('SELECT datname FROM pg_database WHERE datname = $1', [migratedTemplateName()])).rows)).toEqual([]);
});

it('cancellation after migration drops the unpublished template build', async () => {
  await removeTemplate();
  const controller = new AbortController();
  const query = Client.prototype.query;
  // eslint-disable-next-line @typescript-eslint/no-misused-promises -- pg types query's callback overloads as void; the real method returns this promise
  jest.spyOn(Client.prototype, 'query').mockImplementation(async function (this: Client, ...args: unknown[]) {
    const result = await Reflect.apply(query, this, args);
    if (args[0] === 'SELECT pg_advisory_unlock($1)' && (args[1] as number[])?.[0] === 7262001) controller.abort(new Error('synthetic cancelled template'));
    return result;
  } as typeof query);
  await expect(ensureMigratedTemplate(base, controller.signal)).rejects.toThrow('synthetic cancelled template');
  expect(controller.signal.aborted).toBe(true);
  expect(await withAdmin(base, async (c) => (await c.query('SELECT datname FROM pg_database WHERE datname = $1', [migratedTemplateName()])).rows)).toEqual([]);
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
    const builder = create.apply(Test, args),
      compile = builder.compile.bind(builder);
    jest.spyOn(builder, 'compile').mockImplementation(async (...params) => {
      const module = await compile(...params),
        createApp = module.createNestApplication.bind(module);
      jest.spyOn(module, 'createNestApplication').mockImplementation((...options) => {
        const app = createApp(...options),
          listen = app.listen.bind(app);
        jest.spyOn(app, 'listen').mockImplementation(async (...listenArgs) => {
          await listen(...listenArgs);
          server = app.getHttpServer();
          throw new Error('synthetic listen rejection');
        });
        return app;
      });
      return module;
    });
    return builder;
  });
  await expect(createTestApp()).rejects.toThrow('synthetic listen rejection');
  expect(server).toBeDefined();
  expect(server!.listening).toBe(false);
});

it('cancellation after compile closes the module and never starts a listener', async () => {
  const controller = new AbortController(),
    create = Test.createTestingModule;
  let createApp: jest.SpyInstance | undefined;
  jest.spyOn(Test, 'createTestingModule').mockImplementation((...args) => {
    const builder = create.apply(Test, args),
      compile = builder.compile.bind(builder);
    jest.spyOn(builder, 'compile').mockImplementation(async (...params) => {
      const module = await compile(...params);
      createApp = jest.spyOn(module, 'createNestApplication');
      controller.abort(new Error('synthetic cancelled fixture'));
      return module;
    });
    return builder;
  });
  await expect(createTestApp({ signal: controller.signal })).rejects.toThrow('synthetic cancelled fixture');
  expect(createApp).not.toHaveBeenCalled();
});

it('concurrent close callers share cleanup and a failed app close does not skip database disposal', async () => {
  const create = Test.createTestingModule;
  jest.spyOn(Test, 'createTestingModule').mockImplementation((...args) => {
    const builder = create.apply(Test, args),
      compile = builder.compile.bind(builder);
    jest.spyOn(builder, 'compile').mockImplementation(async (...params) => {
      const module = await compile(...params),
        createApp = module.createNestApplication.bind(module);
      jest.spyOn(module, 'createNestApplication').mockImplementation((...options) => {
        const app = createApp(...options),
          close = app.close.bind(app);
        jest.spyOn(app, 'close').mockImplementation(async () => {
          await close();
          throw new Error('synthetic close rejection');
        });
        return app;
      });
      return module;
    });
    return builder;
  });
  const app = await createTestApp();
  const first = app.close(),
    second = app.close();
  expect(first).toBe(second);
  await expect(first).rejects.toThrow('synthetic close rejection');
  await expect(second).rejects.toThrow('synthetic close rejection');
});

it('attempts all disposals and retains original and cleanup failures exactly once', async () => {
  const original = new Error('synthetic original'),
    cleanup = new Error('synthetic cleanup');
  const calls: string[] = [];
  const dispose = onceFixtureCleanup(() =>
    disposeFixtures(
      [
        async () => {
          calls.push('first');
          throw cleanup;
        },
        async () => {
          calls.push('last');
        },
      ],
      [original],
    ),
  );
  const first = dispose(),
    second = dispose();
  expect(first).toBe(second);
  await expect(first).rejects.toMatchObject({ errors: [original, cleanup] });
  expect(calls).toEqual(['first', 'last']);
});

it('retains both work and client-end errors while still closing the real connection', async () => {
  const end = Client.prototype.end;
  // eslint-disable-next-line @typescript-eslint/no-misused-promises -- pg types end's callback overload as void; the real method returns this promise
  jest.spyOn(Client.prototype, 'end').mockImplementation(async function (this: Client) {
    await Reflect.apply(end, this, []);
    throw new Error('synthetic end rejection');
  });
  await expect(
    withAdmin(base, async () => {
      throw new Error('synthetic work rejection');
    }),
  ).rejects.toMatchObject({
    errors: [expect.objectContaining({ message: 'synthetic work rejection' }), expect.objectContaining({ message: 'synthetic end rejection' })],
  });
});
