import { loadEnv } from './env';

const base = { JWT_SECRET: 'a-test-secret-that-is-comfortably-over-32-chars' };

describe('loadEnv', () => {
  it('applies safe defaults', () => {
    expect(loadEnv({ ...base })).toMatchObject({
      NODE_ENV: 'development',
      PORT: 3000,
      LOG_LEVEL: 'info',
      AUTH_VERIFIER: 'hmac',
    });
  });

  it('coerces PORT from a string and rejects out-of-range ports', () => {
    expect(loadEnv({ ...base, PORT: '8080' }).PORT).toBe(8080);
    expect(() => loadEnv({ ...base, PORT: '70000' })).toThrow(/PORT/);
    expect(() => loadEnv({ ...base, PORT: 'abc' })).toThrow(/PORT/);
  });

  it('sizes the application database pool from DATABASE_POOL_MAX: 10 by default, bounded, named when refused', () => {
    expect(loadEnv({ ...base }).DATABASE_POOL_MAX).toBe(10);
    expect(loadEnv({ ...base, DATABASE_POOL_MAX: '4' }).DATABASE_POOL_MAX).toBe(4);
    for (const bad of ['0', '51', '2.5', 'ten']) expect(() => loadEnv({ ...base, DATABASE_POOL_MAX: bad })).toThrow(/DATABASE_POOL_MAX/);
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
      expect(loadEnv({ ...base, CORS_ALLOWED_ORIGINS: 'https://a.example.com, http://localhost:5173' }).CORS_ALLOWED_ORIGINS).toEqual([
        'https://a.example.com',
        'http://localhost:5173',
      ]);
    });
    it('rejects anything that is not a bare origin (paths, wildcards, trailing slashes)', () => {
      for (const bad of ['https://a.example.com/', 'https://a.example.com/app', '*', 'a.example.com']) {
        expect(() => loadEnv({ ...base, CORS_ALLOWED_ORIGINS: bad })).toThrow(/CORS_ALLOWED_ORIGINS/);
      }
    });
  });

  it('takes the listener certificate and key together, or neither', () => {
    expect(loadEnv({ ...base, TLS_CERT_PEM: 'cert', TLS_KEY_PEM: 'key' })).toMatchObject({ TLS_CERT_PEM: 'cert', TLS_KEY_PEM: 'key' });
    expect(loadEnv({ ...base }).TLS_CERT_PEM).toBeUndefined();
    expect(() => loadEnv({ ...base, TLS_CERT_PEM: 'cert' })).toThrow(/TLS_KEY_PEM/);
    expect(() => loadEnv({ ...base, TLS_KEY_PEM: 'key' })).toThrow(/TLS_KEY_PEM/);
  });

  describe('production fails closed', () => {
    const production = {
      NODE_ENV: 'production',
      AUTH_VERIFIER: 'cognito',
      COGNITO_REGION: 'us-east-2',
      COGNITO_USER_POOL_ID: 'us-east-2_AbCdEf123',
      COGNITO_APP_CLIENT_ID: 'client123',
      STORAGE_DRIVER: 'postgres',
      DATABASE_URL: 'postgres://app@db/app',
      DATABASE_SSL: 'require',
      OBJECT_STORAGE_DRIVER: 's3',
      REPORTS_BUCKET: 'a-bucket',
      CORS_ALLOWED_ORIGINS: 'https://app.example.com',
      LEDGER_VERIFIER_DATABASE_URL: 'postgres://verifier@db/app',
      TRUST_PROXY_HOPS: '1',
      INVITATION_DIGEST_KEY: 'ab'.repeat(32),
      IDENTIFIER_DIGEST_KEY: 'cd'.repeat(32),
      TLS_CERT_PEM: 'synthetic-cert-pem',
      TLS_KEY_PEM: 'synthetic-key-pem',
    };

    it('starts with the real setup', () => {
      expect(loadEnv(production).NODE_ENV).toBe('production');
    });

    it.each([
      ['the shared-secret verifier', { AUTH_VERIFIER: 'hmac', JWT_SECRET: 'x'.repeat(40) }, /AUTH_VERIFIER/],
      ["an issuer override (it could point at an attacker's keys)", { COGNITO_ISSUER: 'https://evil.example.com' }, /COGNITO_ISSUER/],
      ['a key-set override', { COGNITO_JWKS_URI: 'https://evil.example.com/jwks.json' }, /COGNITO_ISSUER/],
      ['the in-memory database', { STORAGE_DRIVER: 'memory' }, /STORAGE_DRIVER/],
      ['in-memory file storage', { OBJECT_STORAGE_DRIVER: 'memory' }, /OBJECT_STORAGE_DRIVER/],
      ['an unencrypted database connection', { DATABASE_SSL: 'disable' }, /DATABASE_SSL/],
      ['a plain-http CORS origin', { CORS_ALLOWED_ORIGINS: 'http://app.example.com' }, /CORS_ALLOWED_ORIGINS/],
      ['rate limiting switched off', { RATE_LIMIT_ENABLED: 'false' }, /RATE_LIMIT_ENABLED.*production/],
      ['an unset proxy setting (it would defeat or poison the address limit)', { TRUST_PROXY_HOPS: undefined }, /TRUST_PROXY_HOPS.*production/],
      ['a missing invitation digest key', { INVITATION_DIGEST_KEY: undefined }, /INVITATION_DIGEST_KEY.*production/],
      ['a malformed invitation digest key', { INVITATION_DIGEST_KEY: 'short' }, /INVITATION_DIGEST_KEY/],
      ['a missing identifier digest key', { IDENTIFIER_DIGEST_KEY: undefined }, /IDENTIFIER_DIGEST_KEY.*production/],
      ['a malformed identifier digest key', { IDENTIFIER_DIGEST_KEY: 'short' }, /IDENTIFIER_DIGEST_KEY/],
      ['no listener certificate (the load balancer would reach the task in clear text)', { TLS_CERT_PEM: undefined, TLS_KEY_PEM: undefined }, /TLS_CERT_PEM.*production/],
      ['a listener certificate without its key', { TLS_KEY_PEM: undefined }, /TLS_KEY_PEM/],
      ['a missing ledger verifier login', { LEDGER_VERIFIER_DATABASE_URL: undefined }, /LEDGER_VERIFIER_DATABASE_URL.*production/],
      [
        'the synthetic lab-report pipeline',
        { LAB_REPORT_PIPELINE: 'enabled', LAB_REPORT_FIXTURES_DIR: '/some/recorded/pdfs', KNOWLEDGE_DIR: '/k', BUILD_VERSION: 'b1' },
        /LAB_REPORT_PIPELINE.*production/,
      ],
    ])('refuses %s', (_name, change, message) => {
      expect(() => loadEnv({ ...production, ...change })).toThrow(message);
    });
  });

  describe('the lab-report pipeline switch', () => {
    const database = { STORAGE_DRIVER: 'postgres', DATABASE_URL: 'postgres://app@db/app', LEDGER_VERIFIER_DATABASE_URL: 'postgres://verifier@db/app' };
    const fixtures = { LAB_REPORT_FIXTURES_DIR: '/some/recorded/pdfs', KNOWLEDGE_DIR: '/some/knowledge', BUILD_VERSION: 'build-1' };

    it('is off by default, and "disabled" is the only way it stays off', () => {
      expect(loadEnv({ ...base }).LAB_REPORT_PIPELINE).toBe('disabled');
      expect(loadEnv({ ...base, LAB_REPORT_PIPELINE: 'disabled' }).LAB_REPORT_PIPELINE).toBe('disabled');
    });

    it('can be enabled with the real database outside production', () => {
      expect(loadEnv({ ...base, ...database, ...fixtures, LAB_REPORT_PIPELINE: 'enabled' }).LAB_REPORT_PIPELINE).toBe('enabled');
    });

    it.each(['LAB_REPORT_FIXTURES_DIR', 'KNOWLEDGE_DIR', 'BUILD_VERSION'])('needs %s when enabled (there is no default), and does not need it while off', (name) => {
      const without = Object.fromEntries(Object.entries(fixtures).filter(([key]) => key !== name));
      expect(() => loadEnv({ ...base, ...database, ...without, LAB_REPORT_PIPELINE: 'enabled' })).toThrow(new RegExp(name));
      expect(() => loadEnv({ ...base, ...database, ...without, [name]: '', LAB_REPORT_PIPELINE: 'enabled' })).toThrow(new RegExp(name));
      expect(loadEnv({ ...base })[name as 'BUILD_VERSION']).toBeUndefined();
    });

    it('validates the build version and bounds the reader concurrency (default 2, 1 to 16)', () => {
      for (const bad of ['', 'has space', 'x'.repeat(65), 'semi;colon'])
        expect(() => loadEnv({ ...base, ...database, ...fixtures, BUILD_VERSION: bad, LAB_REPORT_PIPELINE: 'enabled' })).toThrow(/BUILD_VERSION/);
      expect(loadEnv({ ...base }).LAB_REPORT_MAX_CONCURRENT_READS).toBe(2);
      for (const bad of ['0', '17', 'many', '1.5']) expect(() => loadEnv({ ...base, LAB_REPORT_MAX_CONCURRENT_READS: bad })).toThrow(/LAB_REPORT_MAX_CONCURRENT_READS/);
      expect(loadEnv({ ...base, LAB_REPORT_MAX_CONCURRENT_READS: '16' }).LAB_REPORT_MAX_CONCURRENT_READS).toBe(16);
    });

    it('is refused with the in-memory store (the ledger has no in-memory version)', () => {
      expect(() => loadEnv({ ...base, LAB_REPORT_PIPELINE: 'enabled' })).toThrow(/LAB_REPORT_PIPELINE.*postgres/);
    });

    it.each(['yes', 'true', 'ENABLED', '1', ''])('rejects the value %j instead of guessing', (value) => {
      expect(() => loadEnv({ ...base, ...database, ...fixtures, LAB_REPORT_PIPELINE: value })).toThrow(/LAB_REPORT_PIPELINE/);
    });

    it('bounds the download link lifetime to 60 to 600 seconds, default 120', () => {
      expect(loadEnv({ ...base }).DOWNLOAD_URL_TTL_SECONDS).toBe(120);
      for (const bad of ['59', '601', 'abc']) expect(() => loadEnv({ ...base, DOWNLOAD_URL_TTL_SECONDS: bad })).toThrow(/DOWNLOAD_URL_TTL_SECONDS/);
      expect(loadEnv({ ...base, DOWNLOAD_URL_TTL_SECONDS: '600' }).DOWNLOAD_URL_TTL_SECONDS).toBe(600);
    });
  });
  describe('the ledger watch settings', () => {
    const database = { STORAGE_DRIVER: 'postgres', DATABASE_URL: 'postgres://app@db/app' };
    const verifier = { LEDGER_VERIFIER_DATABASE_URL: 'postgres://verifier@db/app' };

    it('is optional outside production and the pipeline, with a 20 s startup budget and a daily full check by default', () => {
      const env = loadEnv({ ...base });
      expect(env.LEDGER_VERIFIER_DATABASE_URL).toBeUndefined();
      expect(env.LEDGER_STARTUP_BUDGET_MS).toBe(20_000);
      expect(env.LEDGER_FULL_VERIFY_INTERVAL_HOURS).toBe(24);
    });

    it('is required when the pipeline is enabled (the log must be watched while it is written)', () => {
      const pipeline = { ...base, ...database, LAB_REPORT_PIPELINE: 'enabled', LAB_REPORT_FIXTURES_DIR: '/f', KNOWLEDGE_DIR: '/k', BUILD_VERSION: 'b1' };
      expect(() => loadEnv(pipeline)).toThrow(/LEDGER_VERIFIER_DATABASE_URL.*LAB_REPORT_PIPELINE=enabled/);
      expect(loadEnv({ ...pipeline, ...verifier }).LEDGER_VERIFIER_DATABASE_URL).toBe(verifier.LEDGER_VERIFIER_DATABASE_URL);
    });

    it("must be a different login from the application's, and needs the real database", () => {
      expect(() => loadEnv({ ...base, ...database, LEDGER_VERIFIER_DATABASE_URL: database.DATABASE_URL })).toThrow(/LEDGER_VERIFIER_DATABASE_URL.*not the application login/);
      expect(() => loadEnv({ ...base, ...verifier })).toThrow(/LEDGER_VERIFIER_DATABASE_URL.*STORAGE_DRIVER=postgres/);
    });

    it('never puts a connection string in the error text', () => {
      let text = '';
      try {
        loadEnv({ ...base, ...database, LEDGER_VERIFIER_DATABASE_URL: database.DATABASE_URL });
      } catch (error) {
        text = (error as Error).message;
      }
      expect(text).toMatch(/LEDGER_VERIFIER_DATABASE_URL/);
      expect(text).not.toContain('postgres://');
    });

    it('bounds the startup budget (1 s to 5 min) and the interval (0 to 168 hours; 0 turns the timer off)', () => {
      for (const bad of ['999', '300001', 'soon', '1.5']) expect(() => loadEnv({ ...base, LEDGER_STARTUP_BUDGET_MS: bad })).toThrow(/LEDGER_STARTUP_BUDGET_MS/);
      for (const bad of ['-1', '169', 'daily', '1.5']) expect(() => loadEnv({ ...base, LEDGER_FULL_VERIFY_INTERVAL_HOURS: bad })).toThrow(/LEDGER_FULL_VERIFY_INTERVAL_HOURS/);
      expect(loadEnv({ ...base, LEDGER_STARTUP_BUDGET_MS: '1000', LEDGER_FULL_VERIFY_INTERVAL_HOURS: '0' })).toMatchObject({
        LEDGER_STARTUP_BUDGET_MS: 1000,
        LEDGER_FULL_VERIFY_INTERVAL_HOURS: 0,
      });
    });
  });

  describe('rate limiting settings', () => {
    it('is on by default, with 300 per address and 120 / 30 / 10 per person per minute, and no proxy trusted', () => {
      const env = loadEnv({ ...base });
      expect(env).toMatchObject({
        RATE_LIMIT_ENABLED: true,
        RATE_LIMIT_IP_PER_MINUTE: 300,
        RATE_LIMIT_READ_PER_MINUTE: 120,
        RATE_LIMIT_WRITE_PER_MINUTE: 30,
        RATE_LIMIT_EXPENSIVE_PER_MINUTE: 10,
      });
      expect(env.TRUST_PROXY_HOPS).toBeUndefined();
    });

    it('accepts explicit values, including 0 proxies (nothing in front)', () => {
      expect(loadEnv({ ...base, RATE_LIMIT_ENABLED: 'false', RATE_LIMIT_READ_PER_MINUTE: '5', TRUST_PROXY_HOPS: '0' })).toMatchObject({
        RATE_LIMIT_ENABLED: false,
        RATE_LIMIT_READ_PER_MINUTE: 5,
        TRUST_PROXY_HOPS: 0,
      });
    });

    it.each(['RATE_LIMIT_IP_PER_MINUTE', 'RATE_LIMIT_READ_PER_MINUTE', 'RATE_LIMIT_WRITE_PER_MINUTE', 'RATE_LIMIT_EXPENSIVE_PER_MINUTE'])(
      'bounds %s to 1 through 100000',
      (name) => {
        for (const bad of ['0', '-1', '100001', 'lots', '1.5']) expect(() => loadEnv({ ...base, [name]: bad })).toThrow(new RegExp(name));
        expect(loadEnv({ ...base, [name]: '1' })[name as 'RATE_LIMIT_IP_PER_MINUTE']).toBe(1);
      },
    );

    it('bounds TRUST_PROXY_HOPS to 0 through 5 and rejects a boolean-looking value for the switch', () => {
      for (const bad of ['-1', '6', 'one', '1.5']) expect(() => loadEnv({ ...base, TRUST_PROXY_HOPS: bad })).toThrow(/TRUST_PROXY_HOPS/);
      for (const bad of ['yes', '1', '', 'ON']) expect(() => loadEnv({ ...base, RATE_LIMIT_ENABLED: bad })).toThrow(/RATE_LIMIT_ENABLED/);
    });
  });

  describe('the session issuer address (ISSUER_URL, DATA-01)', () => {
    const production = {
      NODE_ENV: 'production',
      AUTH_VERIFIER: 'cognito',
      COGNITO_REGION: 'us-east-2',
      COGNITO_USER_POOL_ID: 'us-east-2_AbCdEf123',
      COGNITO_APP_CLIENT_ID: 'client123',
      STORAGE_DRIVER: 'postgres',
      DATABASE_URL: 'postgres://app@db/app',
      DATABASE_SSL: 'require',
      OBJECT_STORAGE_DRIVER: 's3',
      REPORTS_BUCKET: 'a-bucket',
      CORS_ALLOWED_ORIGINS: 'https://app.example.com',
      LEDGER_VERIFIER_DATABASE_URL: 'postgres://verifier@db/app',
      TRUST_PROXY_HOPS: '1',
      INVITATION_DIGEST_KEY: 'ab'.repeat(32),
      IDENTIFIER_DIGEST_KEY: 'cd'.repeat(32),
      TLS_CERT_PEM: 'synthetic-cert-pem',
      TLS_KEY_PEM: 'synthetic-key-pem',
    };

    it("is unset by default, which keeps today's behaviour (no issuer is asked), in development and in production", () => {
      expect(loadEnv({ ...base }).ISSUER_URL).toBeUndefined();
      expect(loadEnv(production).ISSUER_URL).toBeUndefined();
    });

    it('accepts the Service Connect name the deployed service uses, and a loopback address for tests', () => {
      expect(loadEnv({ ...base, ISSUER_URL: 'http://session-issuer:8082' }).ISSUER_URL).toBe('http://session-issuer:8082');
      expect(loadEnv({ ...production, ISSUER_URL: 'http://session-issuer:8082' }).ISSUER_URL).toBe('http://session-issuer:8082');
      expect(loadEnv({ ...base, ISSUER_URL: 'http://127.0.0.1:41234' }).ISSUER_URL).toBe('http://127.0.0.1:41234');
    });

    it.each([
      ['an empty value (it would silently turn the issuer off)', ''],
      ['a bare host', 'session-issuer:8082'],
      ['another scheme', 'ftp://session-issuer'],
      ['credentials', 'http://caller:secret@session-issuer:8082'],
      ['a query', 'http://session-issuer:8082/?x=1'],
      ['a fragment', 'http://session-issuer:8082/#x'],
      ['a path', 'http://session-issuer:8082/v1'],
    ])('refuses %s at start-up, in development and in production, naming the setting', (_name, value) => {
      expect(() => loadEnv({ ...base, ISSUER_URL: value })).toThrow(/ISSUER_URL/);
      expect(() => loadEnv({ ...production, ISSUER_URL: value })).toThrow(/ISSUER_URL/);
    });

    it('never repeats the value in the message, so credentials in it are not printed', () => {
      const marker = `sentinel-${Math.random().toString(16).slice(2, 14)}`;
      for (const value of [`http://caller:${marker}@host-${marker}:8082`, `http://host-${marker}/?token=${marker}`, `ftp://${marker}`]) {
        let message = '';
        try {
          loadEnv({ ...base, ISSUER_URL: value });
        } catch (e) {
          message = (e as Error).message;
        }
        expect(message).toMatch(/ISSUER_URL/);
        expect(message).not.toContain(marker);
      }
    });
  });
});
