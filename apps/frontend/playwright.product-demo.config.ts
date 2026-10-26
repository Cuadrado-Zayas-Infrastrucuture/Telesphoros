import { defineConfig } from '@playwright/test';
import foundation from './playwright.config';

// Runs only against an already-started, owned synthetic demo at the fixed loopback URL.
// It does not start, reuse, stop or alter any service or clinical engine.
export default defineConfig({
  ...foundation,
  testDir: './product-demo-e2e',
  webServer: undefined,
  workers: 1,
  use: { ...foundation.use, trace: 'off', screenshot: 'off' },
});
