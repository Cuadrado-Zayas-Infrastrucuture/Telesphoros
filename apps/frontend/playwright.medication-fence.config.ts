import { defineConfig } from '@playwright/test';
import storage from './playwright.storage.config';

const servers = storage.webServer as { command: string; url: string; reuseExistingServer: boolean; timeout: number; env?: Record<string, string> }[];
export default defineConfig({
  ...storage,
  testDir: './medication-fence-e2e',
  webServer: servers.map((server, index) => index === 2 ? { ...server, env: { ...server.env, MEDICATION_WRITES: 'disabled' } } : server),
});
