import { loadEnv } from '../../src/config/env';

// Test-only values. Real secrets never appear in the repository (see .env.example).
export const TEST_SECRET = 'test-only-secret-0123456789-abcdefghijkl';
export const TEST_ISSUER = 'telesphoros-test';
export const TEST_AUDIENCE = 'telesphoros-api';

export const testEnv = loadEnv({
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  JWT_SECRET: TEST_SECRET,
  JWT_ISSUER: TEST_ISSUER,
  JWT_AUDIENCE: TEST_AUDIENCE,
});
