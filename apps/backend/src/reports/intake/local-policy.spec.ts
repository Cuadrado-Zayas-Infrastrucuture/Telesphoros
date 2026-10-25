import { randomUUID } from 'node:crypto';
import { assertLocalStorage } from './local-policy';
import { loadEnv } from '../../config/env';
import { testEnv } from '../../../test/helpers/env';
const runId = randomUUID();
const rawEnv = { NODE_ENV: 'test', LOG_LEVEL: 'silent', JWT_SECRET: 'test-only-secret-0123456789-abcdefghijkl', JWT_ISSUER: 'telesphoros-test', JWT_AUDIENCE: 'telesphoros-api' };
const env = {
  ...testEnv,
  LOCAL_STORAGE_RUN_ID: runId,
  STORAGE_DRIVER: 'postgres' as const,
  DATABASE_URL: 'postgresql://local-test:local-test@127.0.0.1:54471/test_owned',
  DATABASE_SSL: 'disable' as const,
  OBJECT_STORAGE_DRIVER: 's3' as const,
  S3_ENDPOINT: 'http://127.0.0.1:5571',
  REPORTS_BUCKET: `synthetic-storage-${runId}`,
};
it('requires disposable database/bucket identity, loopback, nonproduction and clinicaloff', () => {
  expect(() => assertLocalStorage(env)).not.toThrow();
  for (const patch of [
    { DATABASE_URL: 'postgresql://127.0.0.1/existing_review' },
    { S3_ENDPOINT: 'https://s3.us-east-2.amazonaws.com' },
    { REPORTS_BUCKET: 'foreign' },
    { NODE_ENV: 'production' as const },
    { LAB_REPORT_PIPELINE: 'enabled' as const },
    { LOCAL_STORAGE_RUN_ID: undefined },
  ])
    expect(() => assertLocalStorage({ ...env, ...patch })).toThrow();
});
it('bounds cleanup grace and refuses shortened policy outside owned local mode', () => {
  expect(testEnv.LOCAL_UPLOAD_CLEANUP_GRACE_SECONDS).toBe(86400);
  for (const value of ['-1', 'NaN', '1.5', '604801']) expect(() => loadEnv({ ...rawEnv, LOCAL_STORAGE_RUN_ID: runId, LOCAL_UPLOAD_CLEANUP_GRACE_SECONDS: value })).toThrow();
  expect(() => loadEnv({ ...rawEnv, LOCAL_UPLOAD_CLEANUP_GRACE_SECONDS: '0' })).toThrow();
  expect(loadEnv({ ...rawEnv, LOCAL_STORAGE_RUN_ID: runId, LOCAL_UPLOAD_CLEANUP_GRACE_SECONDS: '0' }).LOCAL_UPLOAD_CLEANUP_GRACE_SECONDS).toBe(0);
});
