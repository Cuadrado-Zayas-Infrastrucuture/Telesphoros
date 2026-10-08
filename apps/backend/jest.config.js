// Tests compile with swc (fast, supports decorators + metadata). Type safety is `pnpm typecheck`.
// The shared packages resolve to their SOURCE here so tests need no prior build.
//
// Three tiers, so a plain `pnpm test` needs no services:
//   default                       unit + e2e against the in-memory store
//   TEST_DATABASE_URL  set        + test/db/*.pg-spec.ts against a real PostgreSQL
//   TEST_S3_ENDPOINT   set        + test/object-storage/*.s3-spec.ts against an S3-compatible server
// Skipping is announced below, never silent.
const skipped = [];
if (!process.env.TEST_DATABASE_URL) skipped.push('test/db (set TEST_DATABASE_URL; see scripts/dev-postgres.sh)');
if (!process.env.TEST_S3_ENDPOINT) skipped.push('test/object-storage (set TEST_S3_ENDPOINT)');
if (skipped.length > 0) process.stderr.write(`[jest] NOT RUNNING: ${skipped.join('; ')}\n`);

module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  testRegex: '(src|test)/.*\\.(spec|e2e-spec|pg-spec|s3-spec)\\.ts$',
  testPathIgnorePatterns: [
    '/node_modules/',
    ...(process.env.TEST_DATABASE_URL ? [] : ['/test/db/']),
    ...(process.env.TEST_S3_ENDPOINT ? [] : ['/test/object-storage/']),
  ],
  moduleNameMapper: {
    '^@telesphoros/cpic-schema$': '<rootDir>/../../packages/cpic-schema/src/index.ts',
    '^@telesphoros/shared-types$': '<rootDir>/../../packages/shared-types/src/index.ts',
    '^@telesphoros/fake-idp$': '<rootDir>/../../packages/fake-idp/src/index.ts',
  },
  transform: {
    '^.+\\.ts$': [
      '@swc/jest',
      {
        jsc: {
          target: 'es2022',
          parser: { syntax: 'typescript', decorators: true },
          transform: { legacyDecorator: true, decoratorMetadata: true },
        },
        module: { type: 'commonjs' },
      },
    ],
  },
};
