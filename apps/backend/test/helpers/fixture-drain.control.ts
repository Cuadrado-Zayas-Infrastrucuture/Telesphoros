// Explicit real-service control, run only by scripts/test-fixtures/lifecycle.test.cjs; .control.ts is outside normal profile discovery.
//
// Each mode is a deliberately UNPROTECTED spec: the shape of most specs in this package. A fixture build outlasts Jest's five-second
// hook or test budget, so Jest abandons the call and the spec never receives the fixture. Without the end-of-file drain
// (fixture-environment.cjs) the build finishes unowned and the Jest process never exits.
//   FIXTURE_DRAIN_CONTROL=app       the application is built in beforeEach (the local-storage-intake / local-storage-cleanup shape); the file ends
//                                   while the build is still running
//   FIXTURE_DRAIN_CONTROL=db        the database is built in a test body and tracked only after the call returns (the readiness shape); same ending
//   FIXTURE_DRAIN_CONTROL=app-late  as app, but a later case keeps the file running until the abandoned build has finished: the application is
//                                   then listening and unowned, the state that held the hosted Jest process open for 11 and 17 minutes
// Every child is EXPECTED to fail its own test (status 1); the point is that Jest exits by itself and nothing is left behind.
import { Client } from 'pg';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createTestApp } from './app';
import { createEphemeralDatabase, type EphemeralDatabase } from './database';

const SLOW_MS = 6500; // past the five-second default budget
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const mode = process.env.FIXTURE_DRAIN_CONTROL;

if (mode === 'app') {
  let app: NestExpressApplication;
  beforeEach(async () => {
    const create = Test.createTestingModule;
    jest.spyOn(Test, 'createTestingModule').mockImplementation((...args) => {
      const builder = create.apply(Test, args), compile = builder.compile.bind(builder);
      jest.spyOn(builder, 'compile').mockImplementation(async (...params) => { await delay(SLOW_MS); return compile(...params); });
      return builder;
    });
    app = await createTestApp();
  });
  afterEach(async () => { await app.close(); });
  it('a hook that times out while the application is still being built', () => {});
} else if (mode === 'app-late') {
  let app: NestExpressApplication, builds = 0;
  beforeAll(() => {
    const create = Test.createTestingModule;
    jest.spyOn(Test, 'createTestingModule').mockImplementation((...args) => {
      const builder = create.apply(Test, args), compile = builder.compile.bind(builder), slow = builds++ === 0;
      jest.spyOn(builder, 'compile').mockImplementation(async (...params) => { if (slow) await delay(SLOW_MS); return compile(...params); });
      return builder;
    });
  });
  beforeEach(async () => { app = await createTestApp(); });
  afterEach(async () => { await app.close(); });
  it('first case: the hook times out while the application is still being built', () => {});
  it('second case: outlasts the abandoned build, which then finishes and listens', async () => { await delay(5000); });
} else if (mode === 'db') {
  const databases: EphemeralDatabase[] = [];
  afterAll(async () => { await Promise.all(databases.map((database) => database.drop())); });
  it('a test that times out while the database is still being migrated', async () => {
    const connect = Client.prototype.connect;
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- pg types connect's callback overload as void; the real method returns this promise
    jest.spyOn(Client.prototype, 'connect').mockImplementation(async function (this: Client) {
      await Reflect.apply(connect, this, []);
      if (/^test_/.test((this as unknown as { database: string }).database)) await delay(SLOW_MS);
    });
    databases.push(await createEphemeralDatabase());
  });
} else {
  throw new Error('FIXTURE_DRAIN_CONTROL must be "app", "app-late" or "db"');
}
