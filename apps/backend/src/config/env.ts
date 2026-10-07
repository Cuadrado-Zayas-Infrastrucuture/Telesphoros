import { z } from 'zod';

export const ENV = Symbol('ENV');

const booleanString = z.enum(['true', 'false']).transform((value) => value === 'true');

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

    /** Only the development/test verifier exists in Phase 2. The real identity provider arrives in Phase 4. */
    AUTH_VERIFIER: z.enum(['hmac']).default('hmac'),
    JWT_SECRET: z.string().min(32, 'must be at least 32 characters'),
    JWT_ISSUER: z.string().min(1).default('telesphoros-dev'),
    JWT_AUDIENCE: z.string().min(1).default('telesphoros-api'),

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
    if (env.STORAGE_DRIVER === 'postgres' && !env.DATABASE_URL) {
      ctx.addIssue({ code: 'custom', path: ['DATABASE_URL'], message: 'is required when STORAGE_DRIVER=postgres' });
    }
    if (env.OBJECT_STORAGE_DRIVER === 's3' && !env.REPORTS_BUCKET) {
      ctx.addIssue({ code: 'custom', path: ['REPORTS_BUCKET'], message: 'is required when OBJECT_STORAGE_DRIVER=s3' });
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
  const env = parsed.data;
  if (env.NODE_ENV === 'production') {
    // Fail closed: a shared-secret verifier is not acceptable for production traffic.
    throw new Error(
      'Refusing to start with NODE_ENV=production: only the development/test token verifier exists until Phase 4 (real identity provider).',
    );
  }
  return env;
}
