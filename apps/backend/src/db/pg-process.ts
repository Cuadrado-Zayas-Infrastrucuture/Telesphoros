import { spawn } from 'node:child_process';
import { assertNoUrlTls, tlsFromEnv, type DatabaseTls } from './tls';

/**
 * Connection settings go through the environment, never argv: argv is visible to every user via `ps`.
 * TLS follows the same contract as the application's own connections (tls.ts): the URL carries no TLS parameters, and `DATABASE_SSL=require`
 * means `verify-full` here (libpq's `require` encrypts without checking the certificate), against the authority file in `DATABASE_SSL_CA`
 * (or `NODE_EXTRA_CA_CERTS`). Without that file `verify-full` cannot work, so this refuses rather than connecting unverified.
 */
export function pgEnv(url: string, database?: string, tls: DatabaseTls = tlsFromEnv(), source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  assertNoUrlTls(url);
  const parsed = new URL(url);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    PGHOST: parsed.hostname,
    PGPORT: parsed.port || '5432',
    PGUSER: decodeURIComponent(parsed.username),
    PGPASSWORD: decodeURIComponent(parsed.password),
    PGDATABASE: database ?? decodeURIComponent(parsed.pathname.slice(1)),
  };
  if (tls === 'require') {
    const authority = source.DATABASE_SSL_CA || source.NODE_EXTRA_CA_CERTS;
    if (!authority)
      throw new Error('DATABASE_SSL=require needs the certificate authority file for the command-line tools: set DATABASE_SSL_CA (or NODE_EXTRA_CA_CERTS) to its path.');
    env.PGSSLMODE = 'verify-full';
    env.PGSSLROOTCERT = authority;
    env.PGSSLMINPROTOCOLVERSION = 'TLSv1.2';
  } else {
    env.PGSSLMODE = 'disable';
  }
  return env;
}

export const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** Runs a command to completion. Rejects with the command's own stderr (bounded) on a non-zero exit. */
export function run(command: string, args: string[], env: NodeJS.ProcessEnv = { PATH: process.env.PATH }, timeoutMs?: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'ignore', 'pipe'], timeout: timeoutMs });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 4000) stderr += chunk.toString();
    });
    child.on('error', (error) => reject(new Error(`Could not start ${command}: ${error.message}`)));
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}: ${stderr.trim()}`))));
  });
}
