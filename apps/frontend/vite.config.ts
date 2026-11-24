import { fileURLToPath, URL } from 'node:url';
import { brandingPlugin } from './scripts/branding-plugin.mjs';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { imagetools } from 'vite-imagetools';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [brandingPlugin, react(), tailwindcss(), imagetools()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // The shared contract is consumed from source, so no build step is needed first. The bundled medication list is a separate
      // entry, listed first so the package alias below does not swallow it; only the patient screen's chunk imports it.
      '@telesphoros/shared-types/drug-list-data': fileURLToPath(new URL('../../packages/shared-types/src/drug-list-data.ts', import.meta.url)),
      '@telesphoros/shared-types': fileURLToPath(new URL('../../packages/shared-types/src/index.ts', import.meta.url)),
      // Only the outcome and reason vocabulary: the package index would also pull in the engine's guideline data.
      '@telesphoros/cpic-schema/vocabulary': fileURLToPath(new URL('../../packages/cpic-schema/src/vocabulary.ts', import.meta.url)),
      // The glossary (spec 044 slice B part 2), read from source like the shared contract.
      '@telesphoros/help-content': fileURLToPath(new URL('../../packages/help-content/src/index.ts', import.meta.url)),
    },
  },
  build: {
    // The manifest lets scripts/check-chunks.mjs prove every page is its own lazy chunk.
    manifest: true,
    sourcemap: true,
    // Keep shared, framework-free styling utilities separate when new route imports change automatic chunk grouping.
    // React Router likewise: adding the lazy Settings route moved its core from a shared chunk into the entry file (+29 kB gzip there,
    // +45 bytes in what the page loads at start, since both files were preloaded together). Its own group keeps the split stable.
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'ui-utilities', test: /\/node_modules\/(tailwind-merge|class-variance-authority|clsx)\// },
            { name: 'router', test: /\/node_modules\/react-router(-dom)?\// },
          ],
        },
      },
    },
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
