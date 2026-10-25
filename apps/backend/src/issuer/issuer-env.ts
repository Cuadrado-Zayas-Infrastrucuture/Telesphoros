import { z } from 'zod';
import { assertNoUrlTls, type DatabaseTls } from '../db/tls';

/**
 * The session issuer's environment (DATA-01 PR A). Its own loader, not `config/env.ts`: that schema describes the API, and carries every secret the API
 * holds. This one reads a fixed list of variables and nothing else, so a variable that is not named here cannot reach the issuer through its configuration.
 *
 * A refusal names the setting and the rule, never a value. Production refuses to start on any missing value and on anything that is only fit for development.
 */
export class IssuerConfigError extends Error {}

/** Every variable this loader reads. A test pins that it reads nothing else (apart from the presence of FORBIDDEN_IN_PRODUCTION). */
export const ISSUER_ENV_KEYS = [
  'NODE_ENV',
  'PORT',
  'DATABASE_URL',
  'DATABASE_SSL',
  'COGNITO_REGION',
  'COGNITO_USER_POOL_ID',
  'COGNITO_APP_CLIENT_ID',
  'COGNITO_ISSUER',
  'COGNITO_JWKS_URI',
] as const;

/**
 * The application's own secrets and logins. The issuer task is not given them (issuer.tf), and a production issuer that finds one in its environment
 * refuses to start: only their PRESENCE is looked at, never the value. Development ignores them, because a shell that runs the API may have exported them.
 */
export const FORBIDDEN_IN_PRODUCTION = ['JWT_SECRET', 'INVITATION_DIGEST_KEY', 'IDENTIFIER_DIGEST_KEY', 'LEDGER_VERIFIER_DATABASE_URL'] as const;

export interface IssuerConfig {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  /** Connection string for the ISSUER login (`telesphoros_session_issuer`), never the application's. */
  databaseUrl: string;
  databaseTls: DatabaseTls;
  cognito: { issuer: string; clientId: string; jwksUri: string | undefined };
}

const DEFAULT_PORT = 8082;

const schema = z.object({
  // No default: an issuer started without NODE_ENV must not fall back to the lenient mode.
  NODE_ENV: z.enum(['development', 'test', 'production']),
  PORT: z
    .string()
    .regex(/^[0-9]{1,5}$/, 'must be a whole number from 1 to 65535')
    .refine((p) => Number(p) >= 1 && Number(p) <= 65535, 'must be a whole number from 1 to 65535')
    .optional(),
  DATABASE_URL: z.string().min(1),
  DATABASE_SSL: z.enum(['disable', 'require']).optional(),
  COGNITO_REGION: z.string().min(1).optional(),
  COGNITO_USER_POOL_ID: z
    .string()
    .regex(/^[\w-]+_[0-9A-Za-z]+$/, 'must look like us-east-2_AbCdEfGhI')
    .optional(),
  COGNITO_APP_CLIENT_ID: z.string().min(1),
  COGNITO_ISSUER: z.url().optional(),
  COGNITO_JWKS_URI: z.url().optional(),
});

/** Reads the environment. Every refusal names the setting, never its value. */
export function loadIssuerEnv(source: NodeJS.ProcessEnv): IssuerConfig {
  // Pick first: from here on only the named variables exist.
  const picked: Record<string, string | undefined> = {};
  for (const key of ISSUER_ENV_KEYS) picked[key] = source[key];
  const production = picked.NODE_ENV === 'production';
  const problems: string[] = [];
  const problem = (key: string, rule: string) => problems.push(`${key}: ${rule}`);

  const parsed = schema.safeParse(picked);
  if (!parsed.success) {
    for (const issue of parsed.error.issues)
      problem(issue.path.join('.') || 'environment', issue.code === 'invalid_type' && issue.message.includes('undefined') ? 'is required' : issue.message);
  }
  const env = parsed.success ? parsed.data : undefined;

  if (production) {
    if (picked.PORT === undefined) problem('PORT', 'is required in production');
    if (picked.DATABASE_SSL !== 'require') problem('DATABASE_SSL', 'must be require in production');
    if (picked.COGNITO_REGION === undefined) problem('COGNITO_REGION', 'is required in production');
    if (picked.COGNITO_USER_POOL_ID === undefined) problem('COGNITO_USER_POOL_ID', 'is required in production');
    for (const key of ['COGNITO_ISSUER', 'COGNITO_JWKS_URI'] as const) if (picked[key] !== undefined) problem(key, 'is a development-only override and is refused in production');
    for (const key of FORBIDDEN_IN_PRODUCTION) if (source[key] !== undefined) problem(key, 'belongs to the application and must not be given to the issuer');
  } else if (env && !env.COGNITO_ISSUER && (!env.COGNITO_REGION || !env.COGNITO_USER_POOL_ID)) {
    if (!env.COGNITO_REGION) problem('COGNITO_REGION', 'is required unless COGNITO_ISSUER is set');
    if (!env.COGNITO_USER_POOL_ID) problem('COGNITO_USER_POOL_ID', 'is required unless COGNITO_ISSUER is set');
  }

  if (env) {
    try {
      assertNoUrlTls(env.DATABASE_URL, 'DATABASE_URL');
    } catch (error) {
      // tls.ts names the parameters, never the URL.
      problem('DATABASE_URL', (error as Error).message.replace(/^The DATABASE_URL /, ''));
    }
  }

  if (problems.length > 0 || !env) throw new IssuerConfigError(`Invalid issuer configuration: ${[...new Set(problems)].join('; ')}`);

  return {
    nodeEnv: env.NODE_ENV,
    port: env.PORT === undefined ? DEFAULT_PORT : Number(env.PORT),
    databaseUrl: env.DATABASE_URL,
    databaseTls: env.DATABASE_SSL ?? 'disable',
    cognito: {
      issuer: env.COGNITO_ISSUER ?? `https://cognito-idp.${env.COGNITO_REGION}.amazonaws.com/${env.COGNITO_USER_POOL_ID}`,
      clientId: env.COGNITO_APP_CLIENT_ID,
      jwksUri: env.COGNITO_JWKS_URI,
    },
  };
}
