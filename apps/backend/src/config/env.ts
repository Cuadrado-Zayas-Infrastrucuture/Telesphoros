import { z } from 'zod';

export const ENV = Symbol('ENV');

const booleanString = z.enum(['true', 'false']).transform((value) => value === 'true');

const isOrigin = (value: string) => {
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
};

/**
 * TLS parameters in a database URL, by name. db/tls.ts refuses the same names when a connection is built (a test pins the two together). This file
 * cannot import it: it is also loaded on its own, by the infrastructure guard that checks the deployed task environment against it.
 */
const urlTlsParameterNames = (url: string): string[] => {
  try {
    return [...new Set([...new URL(url).searchParams.keys()].filter((name) => /^(ssl|uselibpqcompat)/i.test(name)))];
  } catch {
    return []; // an unreadable URL is refused where the connection is built, without quoting it
  }
};

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

    /**
     * `cognito`: verify Amazon Cognito access tokens against the user pool's published keys (the only
     * option allowed in production). `hmac`: development/test only, a shared secret.
     */
    AUTH_VERIFIER: z.enum(['hmac', 'cognito']).default('hmac'),
    JWT_SECRET: z.string().min(32, 'must be at least 32 characters').optional(),
    JWT_ISSUER: z.string().min(1).default('telesphoros-dev'),
    JWT_AUDIENCE: z.string().min(1).default('telesphoros-api'),
    COGNITO_REGION: z.string().min(1).optional(),
    COGNITO_USER_POOL_ID: z.string().regex(/^[\w-]+_[0-9A-Za-z]+$/, 'must look like us-east-2_AbCdEfGhI').optional(),
    COGNITO_APP_CLIENT_ID: z.string().min(1).optional(),
    /** Local development against the fake identity provider ONLY. Refused in production. */
    COGNITO_ISSUER: z.url().optional(),
    COGNITO_JWKS_URI: z.url().optional(),

    /** Browser origins allowed to call the API, comma separated. Empty (the default) means no cross-origin access. */
    CORS_ALLOWED_ORIGINS: z
      .string()
      .default('')
      .transform((value) => value.split(',').map((origin) => origin.trim()).filter(Boolean))
      .refine((origins) => origins.every(isOrigin), 'each entry must be an origin like https://app.example.com (no path, no trailing slash)'),

    /** `memory` keeps data in process (tests, quick demos). `postgres` is the real store. */
    STORAGE_DRIVER: z.enum(['memory', 'postgres']).default('memory'),
    /** Connection string for the APPLICATION role (a member of telesphoros_app), never the owner. */
    DATABASE_URL: z.string().min(1).optional(),
    DATABASE_SSL: z.enum(['disable', 'require']).default('disable'),

    /** Where report files live. `s3` also covers S3-compatible servers (MinIO) via S3_ENDPOINT. */
    OBJECT_STORAGE_DRIVER: z.enum(['memory', 's3']).default('memory'),
    REPORTS_BUCKET: z.string().min(3).optional(),
    AWS_REGION: z.string().min(1).default('us-east-2'),
    S3_ENDPOINT: z.url().optional(),
    S3_FORCE_PATH_STYLE: booleanString.default(false),
    /** How long a download link for a stored report lives. Short on purpose: a link is a bearer credential and is never revoked early. */
    DOWNLOAD_URL_TTL_SECONDS: z.coerce.number().int().min(60).max(600).default(120),

    /**
     * The lab-report pipeline (capture, review, evaluation) is a synthetic, non-production integration. Off unless switched on here,
     * and refused in production (see below). While `disabled` the routes answer 503 PIPELINE_DISABLED and nothing is read or written.
     */
    LOCAL_STORAGE_RUN_ID: z.uuid().optional(),
    LOCAL_UPLOAD_CLEANUP_GRACE_SECONDS: z.coerce.number().int().min(0).max(604800).default(86400),
    LAB_REPORT_PIPELINE: z.enum(['disabled', 'enabled']).default('disabled'),
    /** Directory of recorded PDFs and their text for the TEST-ONLY text runner. Required when the pipeline is enabled; there is no default. */
    LAB_REPORT_FIXTURES_DIR: z.string().min(1).optional(),
    /** The knowledge directory the pipeline evaluates against (loaded once at start, under the non-production rules). Required when enabled. */
    KNOWLEDGE_DIR: z.string().min(1).optional(),
    /** Stored with every evaluation as the code that produced it. Required when enabled. */
    BUILD_VERSION: z.string().regex(/^[A-Za-z0-9._+-]{1,64}$/, 'must be 1 to 64 letters, digits or . _ + -').optional(),
    /** How many reads of report text may run at once in THIS process (not deployment-wide). Over the limit: 503 PIPELINE_BUSY. */
    LAB_REPORT_MAX_CONCURRENT_READS: z.coerce.number().int().min(1).max(16).default(2),

    /**
     * The ledger watch (docs/ops/ledger-watch.md). The verifier's OWN login (a member of telesphoros_ledger_verifier and of nothing else,
     * never the application's). Required in production and whenever the pipeline is enabled; optional otherwise, and then the watch is off.
     */
    LEDGER_VERIFIER_DATABASE_URL: z.string().min(1).optional(),
    /** How long the checks at start may take in total, across every tenant. Production refuses to start if they do not finish in time. */
    LEDGER_STARTUP_BUDGET_MS: z.coerce.number().int().min(1000).max(300_000).default(20_000),
    /** How often the whole chain is walked again, in hours (jittered by 10%). 0 turns the timer off; the walk after start still runs. */
    LEDGER_FULL_VERIFY_INTERVAL_HOURS: z.coerce.number().int().min(0).max(168).default(24),

    /**
     * Rate limiting (docs/ops/rate-limiting.md). Per PROCESS: two instances each allow the full rate. Production refuses to start with it off.
     * Limits are requests per minute. The per-person limits apply after sign-in, by route class; the address limit applies before.
     */
    RATE_LIMIT_ENABLED: booleanString.default(true),
    RATE_LIMIT_IP_PER_MINUTE: z.coerce.number().int().min(1).max(100_000).default(300),
    RATE_LIMIT_READ_PER_MINUTE: z.coerce.number().int().min(1).max(100_000).default(120),
    RATE_LIMIT_WRITE_PER_MINUTE: z.coerce.number().int().min(1).max(100_000).default(30),
    RATE_LIMIT_EXPENSIVE_PER_MINUTE: z.coerce.number().int().min(1).max(100_000).default(10),
    /**
     * How many reverse proxies (load balancers) sit in front of this process. 0 uses the connection's own address and IGNORES X-Forwarded-For,
     * so a client cannot invent its way out of the address limit. Too low behind a load balancer puts every client in one bucket; too high lets
     * a client spoof its address. Must be set explicitly in production.
     */
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).optional(),

    /**
     * The key for the digest of an invited person's e-mail address (64 hex characters = 256 bits). An invitation stores only this keyed digest and a
     * masked hint; the operator command that fulfils it needs the same key. Required in production; development and tests use a fixed key that
     * is not secret.
     */
    INVITATION_DIGEST_KEY: z.string().regex(/^[0-9a-f]{64}$/, 'must be 64 lower-case hex characters').optional(),

    /**
     * The master secret for the digests of patient identifiers (64 hex characters = 256 bits). A key per organization is derived from it
     * (HKDF, keyed by the organization's id), so no secret is created per clinic. Required in production; development and tests use a fixed key that is
     * not secret. Raw identifiers are never stored, so replacing this key orphans every stored identifier (docs/design/plans/m2-1b-identifiers-and-patient-link.md).
     */
    IDENTIFIER_DIGEST_KEY: z.string().regex(/^[0-9a-f]{64}$/, 'must be 64 lower-case hex characters').optional(),
  })
  .superRefine((env, ctx) => {
    const problem = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });

    if (env.AUTH_VERIFIER === 'hmac' && !env.JWT_SECRET) problem('JWT_SECRET', 'is required when AUTH_VERIFIER=hmac');
    if (env.AUTH_VERIFIER === 'cognito') {
      if (!env.COGNITO_APP_CLIENT_ID) problem('COGNITO_APP_CLIENT_ID', 'is required when AUTH_VERIFIER=cognito');
      if (!env.COGNITO_ISSUER) {
        if (!env.COGNITO_REGION) problem('COGNITO_REGION', 'is required when AUTH_VERIFIER=cognito');
        if (!env.COGNITO_USER_POOL_ID) problem('COGNITO_USER_POOL_ID', 'is required when AUTH_VERIFIER=cognito');
      }
    }
    if (env.STORAGE_DRIVER === 'postgres' && !env.DATABASE_URL) problem('DATABASE_URL', 'is required when STORAGE_DRIVER=postgres');
    for (const key of ['DATABASE_URL', 'LEDGER_VERIFIER_DATABASE_URL'] as const) {
      const names = env[key] ? urlTlsParameterNames(env[key]) : [];
      if (names.length > 0) problem(key, `must not carry TLS parameters (${names.join(', ')}): they can override DATABASE_SSL, which is the only TLS setting`);
    }
    if (env.OBJECT_STORAGE_DRIVER === 's3' && !env.REPORTS_BUCKET) problem('REPORTS_BUCKET', 'is required when OBJECT_STORAGE_DRIVER=s3');

    // The watch needs the database and its own login; the production and pipeline requirements are checked next to each of those.
    if (env.LEDGER_VERIFIER_DATABASE_URL !== undefined) {
      if (env.STORAGE_DRIVER !== 'postgres') problem('LEDGER_VERIFIER_DATABASE_URL', 'can only be set with STORAGE_DRIVER=postgres (the ledger has no in-memory version)');
      if (env.LEDGER_VERIFIER_DATABASE_URL === env.DATABASE_URL) problem('LEDGER_VERIFIER_DATABASE_URL', 'must be the ledger verifier login, not the application login (DATABASE_URL)');
    }

    if (env.LAB_REPORT_PIPELINE === 'enabled') {
      if (!env.LEDGER_VERIFIER_DATABASE_URL) problem('LEDGER_VERIFIER_DATABASE_URL', 'is required when LAB_REPORT_PIPELINE=enabled (the record log must be watched while it is written)');
      // The pipeline's records are a database guarantee (no in-memory ledger exists), and its evidence is pinned to object versions.
      if (env.STORAGE_DRIVER !== 'postgres') problem('LAB_REPORT_PIPELINE', 'can only be enabled with STORAGE_DRIVER=postgres (the ledger has no in-memory version)');
      if (!env.KNOWLEDGE_DIR) problem('KNOWLEDGE_DIR', 'is required when LAB_REPORT_PIPELINE=enabled');
      if (!env.BUILD_VERSION) problem('BUILD_VERSION', 'is required when LAB_REPORT_PIPELINE=enabled (it is stored with every evaluation)');
      if (!env.LAB_REPORT_FIXTURES_DIR) problem('LAB_REPORT_FIXTURES_DIR', 'is required when LAB_REPORT_PIPELINE=enabled (the directory of recorded PDFs for the test-only text runner)');
      if (env.NODE_ENV === 'production') problem('LAB_REPORT_PIPELINE', 'is refused in production: it is a synthetic, non-production integration (test-only text runner and development knowledge)');
    }

    if (env.LOCAL_UPLOAD_CLEANUP_GRACE_SECONDS < 86400 && (!env.LOCAL_STORAGE_RUN_ID || env.NODE_ENV === 'production' || env.LAB_REPORT_PIPELINE !== 'disabled')) problem('LOCAL_UPLOAD_CLEANUP_GRACE_SECONDS', 'shortened grace requires a disposable local run with processing disabled');

    // Production fails closed: anything that is only fit for development is refused outright.
    if (env.NODE_ENV === 'production') {
      if (env.AUTH_VERIFIER !== 'cognito') problem('AUTH_VERIFIER', 'must be cognito in production (the shared-secret verifier is for development and tests)');
      if (env.COGNITO_ISSUER || env.COGNITO_JWKS_URI) problem('COGNITO_ISSUER', 'and COGNITO_JWKS_URI are development-only overrides and are refused in production');
      if (env.STORAGE_DRIVER !== 'postgres') problem('STORAGE_DRIVER', 'must be postgres in production (the in-memory store loses data)');
      if (env.OBJECT_STORAGE_DRIVER !== 's3') problem('OBJECT_STORAGE_DRIVER', 'must be s3 in production');
      if (env.DATABASE_SSL !== 'require') problem('DATABASE_SSL', 'must be require in production');
      if (!env.INVITATION_DIGEST_KEY) problem('INVITATION_DIGEST_KEY', 'is required in production (invitations store only a keyed digest of the address)');
      if (!env.IDENTIFIER_DIGEST_KEY) problem('IDENTIFIER_DIGEST_KEY', 'is required in production (patient identifiers are stored only as keyed digests)');
      if (!env.LEDGER_VERIFIER_DATABASE_URL) problem('LEDGER_VERIFIER_DATABASE_URL', 'is required in production (the record log is verified at start and re-verified while running)');
      if (!env.RATE_LIMIT_ENABLED) problem('RATE_LIMIT_ENABLED', 'must be true in production');
      if (env.TRUST_PROXY_HOPS === undefined) problem('TRUST_PROXY_HOPS', 'must be set explicitly in production (0 if nothing sits in front, 1 behind one load balancer): a wrong value defeats or poisons the address limit');
      if (env.CORS_ALLOWED_ORIGINS.some((origin) => !origin.startsWith('https://'))) problem('CORS_ALLOWED_ORIGINS', 'must all be https:// origins in production');
    }
  });

export type Env = z.infer<typeof envSchema>;

/**
 * Validates configuration at startup so a bad deployment fails immediately and loudly.
 * Error text lists variable NAMES and rules only, never the values (they may be secrets).
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`Invalid environment configuration: ${problems.join('; ')}`);
  }
  return parsed.data;
}
