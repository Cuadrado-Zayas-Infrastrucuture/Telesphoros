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
// The imported report-reader engine is not part of the public repository. Without it the specs that run it are skipped, and said so.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- plain CommonJS, as Jest loads this file
const { readerEnginePresent, SPECS_NEEDING_ENGINE } = require('./test/helpers/reader-engine.cjs');
const withoutEngine = readerEnginePresent() ? [] : SPECS_NEEDING_ENGINE;
if (withoutEngine.length > 0) skipped.push(`${withoutEngine.length} specs that need the report-reader engine (knowledge/lab-report-reader, sidecars/report-reader; list in test/helpers/reader-engine-specs.json)`);
if (skipped.length > 0) process.stderr.write(`[jest] NOT RUNNING: ${skipped.join('; ')}\n`);

module.exports = {
  rootDir: '.',
  // The node environment, plus: at the end of each file, cancel and close fixtures whose owner (a timed-out hook) is gone. Without it a
  // timed-out fixture build finishes unowned and keeps this process alive after the summary.
  testEnvironment: '<rootDir>/test/helpers/fixture-environment.cjs',
  // JEST_HANDLE_REPORT=1 prints what still holds the process open after the run.
  ...(process.env.JEST_HANDLE_REPORT ? { globalTeardown: '<rootDir>/test/helpers/handle-report.cjs' } : {}),
  // Opt-in diagnostic observer; profile commands, selection and deadlines stay unchanged.
  ...(process.env.OFFSITE_PHASE_TRACE_DIR ? { setupFilesAfterEnv: ['<rootDir>/../../.github/ci/offsite-phase-timings.cjs'] } : {}),
  // Service-backed suites share one PostgreSQL instance. Host CPU-count worker defaults
  // oversubscribe that service during concurrent migrations/restores/checkpoints. Keep
  // suites sequential; concurrency exercised inside a suite and all deadlines stay intact.
  ...(process.env.TEST_DATABASE_URL ? { maxWorkers: 1 } : {}),
  testRegex: '(src|test)/.*\\.(spec|e2e-spec|pg-spec|s3-spec)\\.ts$',
  testPathIgnorePatterns: [
    '/node_modules/',
    ...(process.env.TEST_DATABASE_URL ? [] : ['/test/db/']),
    ...(process.env.TEST_S3_ENDPOINT ? [] : ['/test/object-storage/']),
    ...withoutEngine.map((spec) => `<rootDir>/${spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
  ],
  moduleNameMapper: {
    '^@telesphoros/cpic-schema$': '<rootDir>/../../packages/cpic-schema/src/index.ts',
    '^@telesphoros/jobs$': '<rootDir>/../../packages/jobs/src/index.ts',
    '^@telesphoros/shared-types$': '<rootDir>/../../packages/shared-types/src/index.ts',
    '^@telesphoros/fake-idp$': '<rootDir>/../../packages/fake-idp/src/index.ts',
  },
  // jose 6 and NestJS 12 ship ES modules only, and Jest's CommonJS runtime cannot load them. Production needs no such step (Node 22 loads
  // an ES module from require() natively), so only these are compiled to CommonJS here; every other dependency stays untouched.
  transformIgnorePatterns: ['/node_modules/(?!\\.pnpm/(?:jose|@nestjs\\+[a-z-]+)@|jose/|@nestjs/)'],
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
    '^.+\\.js$': ['@swc/jest', { jsc: { target: 'es2022' }, module: { type: 'commonjs' } }],
  },
};
