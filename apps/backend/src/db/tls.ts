/**
 * The one place that decides how a database connection is encrypted (FD-1, found in the peer review of 2026-10-09).
 *
 * Why it exists: node-postgres lets TLS parameters in the connection URL REPLACE an explicit `ssl` object. With `ssl: { rejectUnauthorized: true }`
 * in code, a URL ending `?sslmode=disable` still connected without TLS, `?sslmode=no-verify` turned verification off, and `require` / `verify-full`
 * silently became `{}` (pg v9 is documented to weaken `require` further). The command-line tools (`pg_dump`, `pg_restore`) read `sslmode` from the same
 * URL, and in `libpq` `require` encrypts without verifying the certificate.
 *
 * The contract: a database URL carries NO TLS parameters (they are refused, by name only, never echoing the URL), and TLS comes from one explicit
 * setting, `DATABASE_SSL`:
 *   - `disable`  no TLS (local development and tests only; production refuses it)
 *   - `require`  TLS 1.2 or newer, certificate chain and host name verified against the system's trusted authorities plus `NODE_EXTRA_CA_CERTS`.
 *                The command-line tools verify the same way, using the authority file named by `DATABASE_SSL_CA` (or `NODE_EXTRA_CA_CERTS`).
 *
 * This file imports nothing from the application, so it can be loaded on its own (the TLS test runs it in a child process).
 */
import type { ConnectionOptions } from 'node:tls';

export type DatabaseTls = 'disable' | 'require';

/** Every URL parameter that influences TLS in node-postgres or libpq: `ssl`, `sslmode`, `sslrootcert`, ..., and `uselibpqcompat`. */
const TLS_PARAMETER = /^(ssl|uselibpqcompat)/i;

/** The names (never the values) of the TLS parameters in a connection URL. An unparseable URL is an error, with no part of it quoted. */
export function urlTlsParameters(url: string): string[] {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('The database URL could not be read as a URL.');
  }
  const names = new Set<string>();
  for (const name of parsed.searchParams.keys()) if (TLS_PARAMETER.test(name)) names.add(name);
  return [...names];
}

/** Throws when the URL carries TLS parameters. `label` names the setting for the message; the URL itself is never included (it holds a password). */
export function assertNoUrlTls(url: string, label = 'database URL'): void {
  const names = urlTlsParameters(url);
  if (names.length > 0) {
    throw new Error(`The ${label} must not carry TLS parameters (${names.join(', ')}): they can override the TLS setting. Remove them and set DATABASE_SSL instead.`);
  }
}

/** Reads `DATABASE_SSL` from the environment: `disable` when it is absent, otherwise exactly `disable` or `require`. */
export function tlsFromEnv(env: NodeJS.ProcessEnv = process.env): DatabaseTls {
  const value = env.DATABASE_SSL;
  if (value === undefined || value === '') return 'disable';
  if (value === 'disable' || value === 'require') return value;
  throw new Error('DATABASE_SSL must be disable or require.');
}

export interface PgConnectionSettings {
  connectionString: string;
  /** Always explicit. With `undefined`, node-postgres would fall back to the PGSSLMODE environment variable. */
  ssl: false | ConnectionOptions;
}

/** The settings every `Pool` and `Client` in the application is built from. */
export function pgClientConfig(url: string, tls: DatabaseTls = tlsFromEnv()): PgConnectionSettings {
  assertNoUrlTls(url);
  return {
    connectionString: url,
    ssl: tls === 'require' ? { rejectUnauthorized: true, minVersion: 'TLSv1.2' } : false,
  };
}
