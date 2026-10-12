import { createRequire } from 'node:module';
import { defineConfig } from '@playwright/test';
import foundation from './playwright.config';
// External services are accepted only through L3's independently checked ownership receipt.
const require = createRequire(import.meta.url);
const ownership = require('../../scripts/local-storage/ownership.cjs');
const run = ownership.load(process.env.L3_RUN_ID);
if (run.phase !== 'ready') throw new Error('Owned L3 stack is not ready.');
process.env.L2_BROWSER_RUN_ID = run.id;
export default defineConfig({
  ...foundation, testDir: './storage-e2e', workers: 1, webServer: undefined,
  projects: foundation.projects!.map(project => ({ ...project, testIgnore: '**/version-pin.spec.ts' })),
  use: { ...foundation.use, trace: 'off', screenshot: 'off' },
});
