import { defineConfig } from '@playwright/test';
import foundation from './playwright.config';

// Launched only by patient-decisions-browser.e2e-spec.ts, which owns the real API/DB/identity fixtures.
export default defineConfig({
  ...foundation,
  testDir: './decision-e2e',
  outputDir: './test-results-decisions',
  workers: 1,
  use: { ...foundation.use, trace: 'off', screenshot: 'off' },
  webServer: {
    command: 'vite build --mode e2e --outDir dist-decision-e2e && vite preview --outDir dist-decision-e2e --host 127.0.0.1 --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
