import { spawn } from 'node:child_process';

/** Connection settings go through the environment, never argv: argv is visible to every user via `ps`. */
export function pgEnv(url: string, database?: string): NodeJS.ProcessEnv {
  const parsed = new URL(url);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    PGHOST: parsed.hostname,
    PGPORT: parsed.port || '5432',
    PGUSER: decodeURIComponent(parsed.username),
    PGPASSWORD: decodeURIComponent(parsed.password),
    PGDATABASE: database ?? decodeURIComponent(parsed.pathname.slice(1)),
  };
  const sslmode = parsed.searchParams.get('sslmode');
  if (sslmode) env.PGSSLMODE = sslmode;
  return env;
}

export const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** Runs a command to completion. Rejects with the command's own stderr (bounded) on a non-zero exit. */
export function run(command: string, args: string[], env: NodeJS.ProcessEnv = { PATH: process.env.PATH }): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 4000) stderr += chunk.toString();
    });
    child.on('error', (error) => reject(new Error(`Could not start ${command}: ${error.message}`)));
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}: ${stderr.trim()}`)),
    );
  });
}
