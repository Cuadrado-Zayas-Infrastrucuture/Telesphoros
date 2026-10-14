import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';

const URL = 'postgres://telesphoros_worker:hunter2-password@db.example:5432/app';

describe('worker configuration', () => {
  it('has safe defaults and names the worker after its host and process', () => {
    const c = loadConfig({ DATABASE_URL: URL }, 'host-1', 42);
    expect(c).toMatchObject({ workerId: 'host-1:42', concurrency: 4, tenantCap: 2, drainSeconds: 30, testJobs: false, databaseTls: 'disable', healthHost: '127.0.0.1' });
  });
  it('refuses bad values by setting name, never echoing the value', () => {
    for (const env of [{}, { DATABASE_URL: URL, WORKER_CONCURRENCY: '0' }, { DATABASE_URL: URL, WORKER_CONCURRENCY: '51' }, { DATABASE_URL: URL, WORKER_POLL_MS: 'soon' }, { DATABASE_URL: URL, WORKER_ID: 'has space' }, { DATABASE_URL: URL, WORKER_TEST_JOBS: 'maybe' }]) {
      expect(() => loadConfig(env)).toThrow(/Worker settings are invalid: /);
    }
    expect(() => loadConfig({ DATABASE_URL: URL, WORKER_ID: 'has space' })).toThrow(/WORKER_ID/);
  });
  it('refuses a URL that carries TLS parameters, without quoting it', () => {
    const error = (() => {
      try {
        loadConfig({ DATABASE_URL: `${URL}?sslmode=disable` });
      } catch (e) {
        return e as Error;
      }
    })();
    expect(error?.message).toContain('sslmode');
    expect(error?.message).not.toContain('hunter2');
  });
  it('refuses, in production, a connection without TLS and the test jobs', () => {
    expect(() => loadConfig({ DATABASE_URL: URL, NODE_ENV: 'production' })).toThrow(/DATABASE_SSL=require/);
    expect(() => loadConfig({ DATABASE_URL: URL, NODE_ENV: 'production', DATABASE_SSL: 'require', WORKER_TEST_JOBS: 'yes', WORKER_TEST_EFFECT_DIR: '/tmp/x' })).toThrow(/Test jobs are refused/);
    expect(loadConfig({ DATABASE_URL: URL, NODE_ENV: 'production', DATABASE_SSL: 'require' }).databaseTls).toBe('require');
  });
  it('needs a marker directory for the test jobs and a short-code host name', () => {
    expect(() => loadConfig({ DATABASE_URL: URL, WORKER_TEST_JOBS: 'yes' })).toThrow(/WORKER_TEST_EFFECT_DIR/);
    expect(() => loadConfig({ DATABASE_URL: URL }, 'host name with spaces')).toThrow(/WORKER_ID/);
  });
});
