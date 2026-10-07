import { defineConfig } from 'tsup';

export default defineConfig([
  {
    // The library: ESM for Vite/Playwright, CJS for the NestJS (Jest) tests, plus types.
    entry: { index: 'src/index.ts' },
    format: ['esm', 'cjs'],
    dts: { compilerOptions: { ignoreDeprecations: '6.0' } }, // see packages/shared-types/tsup.config.ts
    clean: true,
    sourcemap: true,
  },
  {
    // The standalone process uses top-level await, so it is ESM only.
    entry: { cli: 'src/cli.ts' },
    format: ['esm'],
    sourcemap: true,
  },
]);
