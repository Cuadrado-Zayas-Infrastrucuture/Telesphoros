import { defineConfig } from 'vitest/config';

// Explicit local-only suite. Missing or non-owned PostgreSQL configuration is a failure.
export default defineConfig({ test: {
  include: ['test/durable/*.pg.test.ts'], fileParallelism: false, maxWorkers: 1,
  testTimeout: 30_000, hookTimeout: 180_000,
} });
