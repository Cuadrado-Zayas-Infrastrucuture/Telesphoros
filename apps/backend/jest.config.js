// Tests compile with swc (fast, supports decorators + metadata). Type safety is `pnpm typecheck`.
// The shared package resolves to its SOURCE here so tests need no prior build.
module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  testRegex: '(src|test)/.*\\.(spec|e2e-spec)\\.ts$',
  moduleNameMapper: {
    '^@telesphoros/shared-types$': '<rootDir>/../../packages/shared-types/src/index.ts',
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
