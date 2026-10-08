import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { imagetools } from 'vite-imagetools';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react(), tailwindcss(), imagetools()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // The shared contract is consumed from source, so no build step is needed first.
      '@telesphoros/shared-types': fileURLToPath(new URL('../../packages/shared-types/src/index.ts', import.meta.url)),
    },
  },
  build: {
    // The manifest lets scripts/check-chunks.mjs prove every page is its own lazy chunk.
    manifest: true,
    sourcemap: true,
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
    // Must exceed the longest asyncUtilTimeout (src/test/setup.ts), or the test is killed before its own wait can report.
    testTimeout: 30_000,
  },
});
