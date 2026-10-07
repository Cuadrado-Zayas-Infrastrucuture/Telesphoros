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
    UPLOAD_URL_TTL_SECONDS: z.coerce.number().int().min(60).max(900).default(300),
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
    if (env.OBJECT_STORAGE_DRIVER === 's3' && !env.REPORTS_BUCKET) problem('REPORTS_BUCKET', 'is required when OBJECT_STORAGE_DRIVER=s3');

    // Production fails closed: anything that is only fit for development is refused outright.
    if (env.NODE_ENV === 'production') {
      if (env.AUTH_VERIFIER !== 'cognito') problem('AUTH_VERIFIER', 'must be cognito in production (the shared-secret verifier is for development and tests)');
      if (env.COGNITO_ISSUER || env.COGNITO_JWKS_URI) problem('COGNITO_ISSUER', 'and COGNITO_JWKS_URI are development-only overrides and are refused in production');
      if (env.STORAGE_DRIVER !== 'postgres') problem('STORAGE_DRIVER', 'must be postgres in production (the in-memory store loses data)');
      if (env.OBJECT_STORAGE_DRIVER !== 's3') problem('OBJECT_STORAGE_DRIVER', 'must be s3 in production');
      if (env.DATABASE_SSL !== 'require') problem('DATABASE_SSL', 'must be require in production');
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
