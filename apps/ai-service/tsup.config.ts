import { defineConfig } from 'tsup';

// Dual build: ESM for Vite (frontend), CJS for NestJS (backend), plus type declarations for both.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: {
    // tsup's declaration bundler injects `baseUrl`, which TypeScript 6 deprecates. Scoped to the
    // declaration build only; remove once tsup stops injecting it.
    compilerOptions: { ignoreDeprecations: '6.0' },
  },
  clean: true,
  sourcemap: true,
});
