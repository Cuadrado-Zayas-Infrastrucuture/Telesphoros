import { defineConfig } from '@playwright/test';

// The cloud image ships Chromium at a fixed path; locally Playwright finds its own browser.
const executablePath = process.env.CHROMIUM_PATH ?? (process.env.CI ? undefined : '/opt/pw-browsers/chromium');

export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results',
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    launchOptions: { executablePath },
  },
  projects: [
    // Mobile first: 375px is the design baseline, desktop is the check that it still scales up.
    { name: 'mobile-375', use: { viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true } },
    { name: 'desktop-1280', use: { viewport: { width: 1280, height: 800 } } },
  ],
  webServer: {
    command: 'pnpm exec vite preview --host 127.0.0.1 --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
