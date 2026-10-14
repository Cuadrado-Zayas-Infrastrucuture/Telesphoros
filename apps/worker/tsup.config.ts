import { defineConfig } from 'tsup';

// One self-contained bundle: the workspace packages and the single file borrowed from the API (the database TLS rule) are compiled in, so the image needs
// only `pg` and `zod` beside it.
export default defineConfig({
  entry: ['src/main.ts'],
  format: ['cjs'],
  platform: 'node',
  target: 'node22',
  clean: true,
  sourcemap: true,
  noExternal: [/^@telesphoros\//],
});
