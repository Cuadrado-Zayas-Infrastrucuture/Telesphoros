import { defineConfig } from '@playwright/test';
import local from './playwright.local.config';

// Exercise report/chat navigation without enabling owned storage in the default local profile.
// Authentication and the in-memory API remain real; no database or cloud resources are used.
const servers = local.webServer as { command: string; url: string; reuseExistingServer: boolean; timeout: number; env?: Record<string, string> }[];
export default defineConfig({
  ...local,
  testMatch: '**/report-workspace.spec.ts',
  testIgnore: [],
  webServer: servers.map((server, index) => index === servers.length - 1 ? {
    ...server,
    env: { ...server.env, VITE_LOCAL_STORAGE_INTAKE: 'true', VITE_REPORT_STORAGE_ORIGINS: 'http://127.0.0.1:5557' },
  } : server),
});
