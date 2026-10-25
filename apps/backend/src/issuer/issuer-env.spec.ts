import { FORBIDDEN_IN_PRODUCTION, ISSUER_ENV_KEYS, IssuerConfigError, loadIssuerEnv } from './issuer-env';

/**
 * DATA-01 PR A: the issuer's own environment loader. It reads a fixed list of variables and nothing else, refuses to start in production on any missing
 * value or any development override, and never puts a value in a message. Every refusal below is paired with a positive control: the same environment, with
 * only the one fault removed, loads.
 */
const production = {
  NODE_ENV: 'production',
  PORT: '8082',
  DATABASE_URL: 'postgres://issuer-login:pw-sentinel-1@db.internal:5432/telesphoros',
  DATABASE_SSL: 'require',
  COGNITO_REGION: 'us-east-2',
  COGNITO_USER_POOL_ID: 'us-east-2_AbCdEf123',
  COGNITO_APP_CLIENT_ID: 'client-sentinel-2',
};
const development = { ...production, NODE_ENV: 'development', DATABASE_SSL: 'disable' };

const without = (env: Record<string, string>, key: string) => Object.fromEntries(Object.entries(env).filter(([k]) => k !== key));
const messageOf = (env: Record<string, string | undefined>): string => {
  try {
    loadIssuerEnv(env as NodeJS.ProcessEnv);
  } catch (error) {
    expect(error).toBeInstanceOf(IssuerConfigError);
    return (error as Error).message;
  }
  throw new Error('expected the environment to be refused');
};

describe('loadIssuerEnv: the positive controls', () => {
  it('loads the production environment the Terraform task sets, and derives the Cognito issuer from region and pool', () => {
    const config = loadIssuerEnv(production);
    expect(config).toEqual({
      nodeEnv: 'production',
      port: 8082,
      databaseUrl: production.DATABASE_URL,
      databaseTls: 'require',
      cognito: { issuer: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_AbCdEf123', clientId: 'client-sentinel-2', jwksUri: undefined },
    });
  });

  it('in development the port and TLS default (8082, disable), and the Cognito overrides are honoured', () => {
    const config = loadIssuerEnv({
      NODE_ENV: 'development',
      DATABASE_URL: production.DATABASE_URL,
      COGNITO_APP_CLIENT_ID: 'c',
      COGNITO_ISSUER: 'http://127.0.0.1:9999',
      COGNITO_JWKS_URI: 'http://127.0.0.1:9999/keys',
    });
    expect(config).toMatchObject({ port: 8082, databaseTls: 'disable', cognito: { issuer: 'http://127.0.0.1:9999', jwksUri: 'http://127.0.0.1:9999/keys' } });
  });
});

describe('loadIssuerEnv: production refuses to start on any missing value', () => {
  for (const key of Object.keys(production)) {
    it(`without ${key}`, () => {
      expect(messageOf(without(production, key))).toContain(key);
    });
  }
});

describe('loadIssuerEnv: production refuses what only development may do', () => {
  it('refuses COGNITO_ISSUER and COGNITO_JWKS_URI, each alone', () => {
    expect(messageOf({ ...production, COGNITO_ISSUER: 'http://127.0.0.1:9999' })).toContain('COGNITO_ISSUER');
    expect(messageOf({ ...production, COGNITO_JWKS_URI: 'http://127.0.0.1:9999/keys' })).toContain('COGNITO_JWKS_URI');
    expect(() => loadIssuerEnv(production)).not.toThrow(); // control
  });

  it('refuses an overridden issuer even when it is empty (presence is the fault, not the value)', () => {
    expect(messageOf({ ...production, COGNITO_ISSUER: '' })).toContain('COGNITO_ISSUER');
    expect(messageOf({ ...production, COGNITO_JWKS_URI: '' })).toContain('COGNITO_JWKS_URI');
  });

  it('refuses a database connection without TLS', () => {
    expect(messageOf({ ...production, DATABASE_SSL: 'disable' })).toContain('DATABASE_SSL');
    expect(messageOf({ ...production, DATABASE_SSL: 'verify-full' })).toContain('DATABASE_SSL');
    expect(messageOf({ ...production, DATABASE_SSL: '' })).toContain('DATABASE_SSL');
  });
});

describe("loadIssuerEnv: the issuer does not accept or read the application's other secrets", () => {
  for (const key of FORBIDDEN_IN_PRODUCTION) {
    it(`production refuses ${key} being present at all`, () => {
      expect(messageOf({ ...production, [key]: 'application-secret-sentinel-3' })).toContain(key);
      expect(() => loadIssuerEnv(production)).not.toThrow(); // control
    });
  }

  it('the application secrets in development are ignored: they never reach the config', () => {
    // Built at run time, one fake value per forbidden variable: a `NAME: 'literal'` pair is what the repository's secret scan reads as a credential.
    const marker = 'application-secret-sentinel';
    const env = {
      ...development,
      ...Object.fromEntries(FORBIDDEN_IN_PRODUCTION.map((key, i) => [key, key.endsWith('URL') ? `postgres://x:${marker}-${i}@h/d` : `${marker}-${i}`])),
    };
    expect(JSON.stringify(loadIssuerEnv(env))).not.toContain('application-secret-sentinel');
  });

  it('reads only its own variables, plus the presence of the forbidden ones', () => {
    const read = new Set<string>();
    const spy = new Proxy({ ...production, UNRELATED_SECRET: 'x', AWS_SECRET_ACCESS_KEY: 'y', DATABASE_PASSWORD: 'z' } as Record<string, string>, {
      get: (target, key) => {
        if (typeof key === 'string') read.add(key);
        return target[key as string];
      },
      has: (target, key) => {
        if (typeof key === 'string') read.add(key);
        return key in target;
      },
    });
    loadIssuerEnv(spy as NodeJS.ProcessEnv);
    const allowed = new Set<string>([...ISSUER_ENV_KEYS, ...FORBIDDEN_IN_PRODUCTION]);
    expect([...read].filter((key) => !allowed.has(key))).toEqual([]);
    expect(read.size).toBeGreaterThan(5); // control: the proxy saw the reads it was meant to see
    expect(read.has('DATABASE_URL')).toBe(true);
  });
});

describe('loadIssuerEnv: shapes', () => {
  it('refuses a PORT that is not a whole number from 1 to 65535', () => {
    for (const port of ['abc', '0', '70000', '80.5', '-1', '']) expect(messageOf({ ...production, PORT: port })).toContain('PORT');
  });

  it('refuses a user pool id or an unknown NODE_ENV that does not look right', () => {
    expect(messageOf({ ...production, COGNITO_USER_POOL_ID: 'not a pool' })).toContain('COGNITO_USER_POOL_ID');
    expect(messageOf({ ...production, NODE_ENV: 'staging' })).toContain('NODE_ENV');
  });

  it('refuses TLS parameters in the database URL, which could override DATABASE_SSL', () => {
    expect(messageOf({ ...production, DATABASE_URL: `${production.DATABASE_URL}?sslmode=disable` })).toContain('DATABASE_URL');
  });

  it('in development, still needs the database, the app client and a way to find the key set', () => {
    expect(messageOf(without(development, 'DATABASE_URL'))).toContain('DATABASE_URL');
    expect(messageOf(without(development, 'COGNITO_APP_CLIENT_ID'))).toContain('COGNITO_APP_CLIENT_ID');
    expect(messageOf(without(without(development, 'COGNITO_REGION'), 'COGNITO_USER_POOL_ID'))).toContain('COGNITO_REGION');
    expect(messageOf(without(development, 'NODE_ENV'))).toContain('NODE_ENV'); // no silent default to the lenient mode
  });
});

describe('loadIssuerEnv: a refusal names the setting and never quotes a value', () => {
  it('holds for every fault above, with a sentinel in every value', () => {
    const sentinel = 'value-sentinel-9';
    const faulty: Record<string, string> = {
      NODE_ENV: `${sentinel}-env`,
      PORT: `${sentinel}-port`,
      DATABASE_URL: `postgres://u:${sentinel}@h/d?sslmode=disable`,
      DATABASE_SSL: `${sentinel}-ssl`,
      COGNITO_REGION: sentinel,
      COGNITO_USER_POOL_ID: `${sentinel} pool`,
      COGNITO_APP_CLIENT_ID: '',
      COGNITO_ISSUER: `${sentinel}-issuer`,
      COGNITO_JWKS_URI: `${sentinel}-jwks`,
      JWT_SECRET: `${sentinel}-jwt`,
    };
    expect(messageOf(faulty)).not.toContain(sentinel);
    const production2 = { ...production, DATABASE_URL: `postgres://u:${sentinel}@h/d?sslmode=disable`, JWT_SECRET: `${sentinel}-jwt`, COGNITO_ISSUER: `${sentinel}-issuer` };
    expect(messageOf(production2)).not.toContain(sentinel);
  });
});
