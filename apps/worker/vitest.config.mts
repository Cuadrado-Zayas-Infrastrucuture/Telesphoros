import { defineConfig } from 'vitest/config';

// Three tiers, as in the API: a plain run needs no services; TEST_DATABASE_URL adds the suites that run real worker processes against PostgreSQL.
// Skipping is announced, never silent.
const database = Boolean(process.env.TEST_DATABASE_URL);
if (!database) process.stderr.write('[vitest] NOT RUNNING: test/*.pg.test.ts (set TEST_DATABASE_URL; see apps/backend/scripts/dev-postgres.sh)\n');

export default defineConfig({
  resolve: { alias: { '@telesphoros/jobs': new URL('../../packages/jobs/src/index.ts', import.meta.url).pathname } },
  test: {
    include: ['src/**/*.test.ts', ...(database ? ['test/**/*.pg.test.ts'] : [])],
    // Suites share one PostgreSQL and start real processes: keep them sequential.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
