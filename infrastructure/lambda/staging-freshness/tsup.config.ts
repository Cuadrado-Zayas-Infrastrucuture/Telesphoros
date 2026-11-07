import { defineConfig } from 'tsup';

// One self-contained file for the Lambda. The AWS SDK v3 is provided by the Node.js runtime, so it stays external.
export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  outExtension: () => ({ js: '.mjs' }),
  external: [/^@aws-sdk\//],
  clean: true,
  sourcemap: true,
});
