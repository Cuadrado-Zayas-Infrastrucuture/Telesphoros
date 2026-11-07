import { randomUUID } from 'node:crypto';
import { defineConfig } from '@playwright/test';
import foundation from './playwright.config';

// L2 acceptance uses an explicitly supplied disposable, migrated application-role database.
// This is browser-test configuration, not the L3 operational setup/teardown runner.
if (!process.env.E2E_DATABASE_URL) throw new Error('L2 browser acceptance requires E2E_DATABASE_URL.');
const db = new URL(process.env.E2E_DATABASE_URL);
if (db.hostname !== '127.0.0.1' || !/^\/(test_|synthetic_storage_)[a-z0-9_]+$/.test(db.pathname) || db.username === 'postgres') throw new Error('L2 requires a disposable loopback application-role database.');
const runId = process.env.L2_BROWSER_RUN_ID ?? randomUUID();
process.env.L2_BROWSER_RUN_ID = runId;
const servers = foundation.webServer as { command: string; url: string; reuseExistingServer: boolean; timeout: number; env?: Record<string, string> }[];
export default defineConfig({
  ...foundation,
  testDir: './storage-e2e',
  workers: 1,
  projects: [
    ...foundation.projects!.map(project => ({ ...project, testIgnore: '**/version-pin.spec.ts' })),
    { name: 'version-pin', dependencies: foundation.projects!.map(project => project.name!), testMatch: '**/version-pin.spec.ts', use: { viewport: { width: 1280, height: 800 } } },
  ],
  use: { ...foundation.use, trace: 'off', screenshot: 'off' },
  webServer: servers.map((server, index) => index === 1 ? {
    ...server, url: `http://127.0.0.1:5557/synthetic-storage-${runId}`, env: { L2_BROWSER_RUN_ID: runId },
  } : index === 2 ? {
    ...server, env: { ...server.env, LOCAL_STORAGE_RUN_ID: runId, LAB_REPORT_PIPELINE: 'disabled', PATIENT_FIELD_LOCAL_KEY: 'ab'.repeat(32), REPORTS_BUCKET: `synthetic-storage-${runId}` },
  } : index === 3 ? {
    ...server, command: 'pnpm exec vite preview --outDir dist-storage-e2e --host 127.0.0.1 --port 4173 --strictPort',
  } : server),
});
