import { defineConfig } from '@playwright/test';
import foundation from './playwright.storage.config';

// Opt-in measurements against the same synthetic API, identity and S3 fixtures as browser acceptance.
export default defineConfig({
  ...foundation,
  testDir: './performance',
  timeout: 180_000,
  projects: [{ name: 'desktop-1280', use: { viewport: { width: 1280, height: 800 } } }],
  webServer: (foundation.webServer as { command: string; url: string; env?: Record<string, string> }[]).map((server, index) =>
    index === 3
      ? {
          ...server,
          command: 'pnpm exec vite preview --outDir dist-e2e --host 127.0.0.1 --port 4173 --strictPort',
        }
      : server,
  ),
});
