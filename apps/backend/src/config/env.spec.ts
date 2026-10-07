import { loadEnv } from './env';

const base = { JWT_SECRET: 'a-test-secret-that-is-comfortably-over-32-chars' };

describe('loadEnv', () => {
  it('applies safe defaults', () => {
    expect(loadEnv({ ...base })).toMatchObject({
      NODE_ENV: 'development', PORT: 3000, LOG_LEVEL: 'info', AUTH_VERIFIER: 'hmac',
    });
  });

  it('coerces PORT from a string and rejects out-of-range ports', () => {
    expect(loadEnv({ ...base, PORT: '8080' }).PORT).toBe(8080);
    expect(() => loadEnv({ ...base, PORT: '70000' })).toThrow(/PORT/);
    expect(() => loadEnv({ ...base, PORT: 'abc' })).toThrow(/PORT/);
  });

  it('refuses to start without a secret, and names the variable', () => {
    expect(() => loadEnv({})).toThrow(/JWT_SECRET/);
  });

  it('rejects a short secret WITHOUT echoing it back', () => {
    const shortSecret = 'hunter2-too-short';
    let message = '';
    try {
      loadEnv({ JWT_SECRET: shortSecret });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/JWT_SECRET/);
    expect(message).not.toContain(shortSecret);
  });

  it('fails closed in production: no production-grade token verifier exists yet', () => {
    expect(() => loadEnv({ ...base, NODE_ENV: 'production' })).toThrow(/production/i);
  });

  it('rejects an unknown log level or verifier', () => {
    expect(() => loadEnv({ ...base, LOG_LEVEL: 'verbose' })).toThrow(/LOG_LEVEL/);
    expect(() => loadEnv({ ...base, AUTH_VERIFIER: 'none' })).toThrow(/AUTH_VERIFIER/);
  });
});
