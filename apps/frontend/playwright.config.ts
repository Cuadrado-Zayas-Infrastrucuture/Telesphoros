import { defineConfig } from '@playwright/test';

// The cloud image ships Chromium at a fixed path; locally Playwright finds its own browser.
const executablePath = process.env.CHROMIUM_PATH ?? (process.env.CI ? undefined : '/opt/pw-browsers/chromium');

const APP = 'http://127.0.0.1:4173';
const IDP = 'http://127.0.0.1:4010';
const API = 'http://127.0.0.1:3010';

export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results',
  reporter: [['list']],
  use: {
    baseURL: APP,
    launchOptions: { executablePath },
    // On CI, keep evidence of a failure (the workflow uploads test-results for 7 days). Nothing is kept when tests pass.
    trace: process.env.CI ? 'retain-on-failure' : 'off',
    screenshot: process.env.CI ? 'only-on-failure' : 'off',
  },
  projects: [
    // Mobile first: 375px is the design baseline, desktop is the check that it still scales up.
    { name: 'mobile-375', use: { viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true } },
    { name: 'desktop-1280', use: { viewport: { width: 1280, height: 800 } } },
  ],
  // The whole stack, for real: a fake identity provider (TEST ONLY), the built API verifying real RS256 tokens
  // against its key set, and the production-built frontend. Tokens are minted by the identity provider's own flow.
  webServer: [
    {
      command: `node ../../packages/fake-idp/dist/cli.js --port 4010 --client-id e2e-client --redirect-uri ${APP}/auth/callback --logout-uri ${APP}/signed-out`,
      url: `${IDP}/.well-known/openid-configuration`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: 'node scripts/upload-storage-fixture.mjs',
      url: 'http://127.0.0.1:5557/synthetic-product-upload',
      reuseExistingServer: false,
      timeout: 45_000,
    },
    {
      command: 'node ../backend/dist/main.js',
      url: `${API}/api/v1/health`,
      reuseExistingServer: false,
      timeout: 30_000,
      env: {
        PORT: '3010',
        NODE_ENV: 'development',
        LOG_LEVEL: 'warn',
        // Shared fake personas run many uploads at once; quota refusals have an explicit browser control.
        RATE_LIMIT_ENABLED: 'false',
        AUTH_VERIFIER: 'cognito',
        COGNITO_APP_CLIENT_ID: 'e2e-client',
        COGNITO_ISSUER: IDP,
        COGNITO_JWKS_URI: `${IDP}/.well-known/jwks.json`,
        CORS_ALLOWED_ORIGINS: APP,
        STORAGE_DRIVER: process.env.E2E_DATABASE_URL ? 'postgres' : 'memory',
        ...(process.env.E2E_DATABASE_URL ? { DATABASE_URL: process.env.E2E_DATABASE_URL, DATABASE_SSL: 'disable' } : {}),
        OBJECT_STORAGE_DRIVER: 's3',
        S3_ENDPOINT: 'http://127.0.0.1:5557',
        S3_FORCE_PATH_STYLE: 'true',
        REPORTS_BUCKET: 'synthetic-product-upload',
        AWS_REGION: 'us-east-1',
        AWS_ACCESS_KEY_ID: 'synthetic',
        AWS_SECRET_ACCESS_KEY: 'synthetic',
        AWS_EC2_METADATA_DISABLED: 'true',
      },
    },
    {
      command: 'pnpm exec vite preview --outDir dist-e2e --host 127.0.0.1 --port 4173 --strictPort',
      url: APP,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
