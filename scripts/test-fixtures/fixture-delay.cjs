// Loaded only by the bounded lifecycle regression child, never normal application code.
const path = require('node:path');
const databasePath = path.resolve(__dirname, '../../apps/backend/test/helpers/database.ts');
const appPath = path.resolve(__dirname, '../../apps/backend/test/helpers/app.ts');
const mode = process.env.FIXTURE_REGRESSION_MODE;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
if (!['split', 'late', 'lock', 'late-lock'].includes(mode)) throw new Error('Unknown fixture regression mode');
jest.doMock(databasePath, () => {
  const actual = jest.requireActual(databasePath);
  return { ...actual, createEphemeralDatabase: async (...args) => {
    await delay(mode === 'split' ? 2800 : mode === 'lock' ? 3300 : 0);
    return actual.createEphemeralDatabase(...args);
  }};
});
jest.doMock(appPath, () => {
  const actual = jest.requireActual(appPath);
  return { ...actual, createTestApp: async (...args) => {
    const app = await actual.createTestApp(...args);
    // The resource is live BEFORE delivery is delayed: an unowned promise leaks its server.
    await delay(mode === 'late' ? 5500 : mode === 'split' ? 2500 : 0);
    return app;
  }};
});
// Also delay the lock-timeout response after PostgreSQL has correctly refused the DDL.
// This leaves the test body running when Jest times it out; suite teardown must drain it.
if (mode === 'late-lock') {
  const migratorPath = path.resolve(__dirname, '../../apps/backend/src/db/migrator.ts');
  jest.doMock(migratorPath, () => {
    const actual = jest.requireActual(migratorPath);
    return { ...actual, migrateUp: async (...args) => {
      try { return await actual.migrateUp(...args); }
      catch (error) {
        if (/lock timeout/.test(error.message)) await delay(3500);
        throw error;
      }
    }};
  });
}
