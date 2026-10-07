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


  it('rejects an unknown log level or verifier', () => {
    expect(() => loadEnv({ ...base, LOG_LEVEL: 'verbose' })).toThrow(/LOG_LEVEL/);
    expect(() => loadEnv({ ...base, AUTH_VERIFIER: 'none' })).toThrow(/AUTH_VERIFIER/);
  });

  describe('authentication settings', () => {
    const cognito = { AUTH_VERIFIER: 'cognito', COGNITO_REGION: 'us-east-2', COGNITO_USER_POOL_ID: 'us-east-2_AbCdEf123', COGNITO_APP_CLIENT_ID: 'client123' };

    it('hmac needs a secret; cognito needs a client id plus region and pool', () => {
      expect(() => loadEnv({ AUTH_VERIFIER: 'hmac' })).toThrow(/JWT_SECRET/);
      expect(loadEnv(cognito).AUTH_VERIFIER).toBe('cognito');
      expect(() => loadEnv({ ...cognito, COGNITO_APP_CLIENT_ID: undefined })).toThrow(/COGNITO_APP_CLIENT_ID/);
      expect(() => loadEnv({ ...cognito, COGNITO_REGION: undefined })).toThrow(/COGNITO_REGION/);
      expect(() => loadEnv({ ...cognito, COGNITO_USER_POOL_ID: 'not-a-pool' })).toThrow(/COGNITO_USER_POOL_ID/);
    });

    it('accepts a development issuer override instead of region and pool', () => {
      expect(loadEnv({ AUTH_VERIFIER: 'cognito', COGNITO_APP_CLIENT_ID: 'c', COGNITO_ISSUER: 'http://127.0.0.1:4010' }).COGNITO_ISSUER).toBe('http://127.0.0.1:4010');
    });
  });

  describe('CORS origins', () => {
    it('defaults to none and parses a comma-separated list', () => {
      expect(loadEnv({ ...base }).CORS_ALLOWED_ORIGINS).toEqual([]);
      expect(loadEnv({ ...base, CORS_ALLOWED_ORIGINS: 'https://a.example.com, http://localhost:5173' }).CORS_ALLOWED_ORIGINS).toEqual(['https://a.example.com', 'http://localhost:5173']);
    });
    it('rejects anything that is not a bare origin (paths, wildcards, trailing slashes)', () => {
      for (const bad of ['https://a.example.com/', 'https://a.example.com/app', '*', 'a.example.com']) {
        expect(() => loadEnv({ ...base, CORS_ALLOWED_ORIGINS: bad })).toThrow(/CORS_ALLOWED_ORIGINS/);
      }
    });
  });

  describe('production fails closed', () => {
    const production = {
      NODE_ENV: 'production', AUTH_VERIFIER: 'cognito', COGNITO_REGION: 'us-east-2', COGNITO_USER_POOL_ID: 'us-east-2_AbCdEf123',
      COGNITO_APP_CLIENT_ID: 'client123', STORAGE_DRIVER: 'postgres', DATABASE_URL: 'postgres://app@db/app', DATABASE_SSL: 'require',
      OBJECT_STORAGE_DRIVER: 's3', REPORTS_BUCKET: 'a-bucket', CORS_ALLOWED_ORIGINS: 'https://app.example.com',
    };

    it('starts with the real setup', () => {
      expect(loadEnv(production).NODE_ENV).toBe('production');
    });

    it.each([
      ['the shared-secret verifier', { AUTH_VERIFIER: 'hmac', JWT_SECRET: 'x'.repeat(40) }, /AUTH_VERIFIER/],
      ['an issuer override (it could point at an attacker\'s keys)', { COGNITO_ISSUER: 'https://evil.example.com' }, /COGNITO_ISSUER/],
      ['a key-set override', { COGNITO_JWKS_URI: 'https://evil.example.com/jwks.json' }, /COGNITO_ISSUER/],
      ['the in-memory database', { STORAGE_DRIVER: 'memory' }, /STORAGE_DRIVER/],
      ['in-memory file storage', { OBJECT_STORAGE_DRIVER: 'memory' }, /OBJECT_STORAGE_DRIVER/],
      ['an unencrypted database connection', { DATABASE_SSL: 'disable' }, /DATABASE_SSL/],
      ['a plain-http CORS origin', { CORS_ALLOWED_ORIGINS: 'http://app.example.com' }, /CORS_ALLOWED_ORIGINS/],
    ])('refuses %s', (_name, change, message) => {
      expect(() => loadEnv({ ...production, ...change })).toThrow(message);
    });
  });
});
