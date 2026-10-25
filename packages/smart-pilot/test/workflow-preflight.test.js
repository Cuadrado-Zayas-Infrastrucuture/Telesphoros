import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const command = fileURLToPath(new URL('../openemr/verify-workflow.cjs', import.meta.url));
describe('real workflow acceptance preflight', () => {
  it.each([
    { NODE_ENV: 'production' },
    { TEST_DATABASE_URL: '' },
    { TEST_DATABASE_URL: 'postgresql://sensitive-marker@database.example/postgres' },
    { TEST_S3_ENDPOINT: '' },
    { TEST_S3_ENDPOINT: 'https://s3.amazonaws.com' },
    { TEST_S3_ENDPOINT: 'http://sensitive-marker@127.0.0.1:5555' },
  ])('refuses unsafe or absent service configuration before starting children: %j', (override) => {
    const result = spawnSync(process.execPath, [command], {
      encoding: 'utf8',
      timeout: 3000,
      env: { ...process.env, NODE_ENV: 'test', TEST_DATABASE_URL: 'postgresql://test@127.0.0.1:54329/postgres', TEST_S3_ENDPOINT: 'http://127.0.0.1:5555', ...override },
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Workflow preflight failed:');
    expect(result.stderr).not.toContain('sensitive-marker');
  });
});
