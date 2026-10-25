import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { quoteIdent } from '../../src/db/pg-process';
import { withAdmin } from './database';

const exec = promisify(execFile);

/** Restore owns a database, not cluster roles; preserve PostgreSQL's existing built-in roles. */
export async function prepareRecoveryRoles(url: string, roles: string[]) {
  await withAdmin(url, async (client) => {
    for (const role of roles) {
      const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role]);
      if (!exists.rowCount) await client.query(`CREATE ROLE ${quoteIdent(role)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
    }
  });
}

/** Owns one fresh loopback cluster. Never accepts a caller's data directory or target URL. */
export async function recoveryTarget() {
  if (process.getuid?.() === 0) throw new Error('Recovery rehearsal must run as an unprivileged OS user.');
  const bin = process.env.PGBIN ?? (await exec('pg_config', ['--bindir'])).stdout.trim();
  const root = mkdtempSync(join(tmpdir(), 'recovery-target-'));
  const data = join(root, 'data');
  const sockets = join(root, 'sockets');
  mkdirSync(sockets);
  const pw = join(root, 'fixture-password');
  writeFileSync(pw, 'rehearsal-only-password\n', { mode: 0o600 });
  let started = false;
  const stop = async () => {
    // Stop must succeed before deletion: a failed shutdown preserves the cluster for diagnosis.
    if (started) await exec(join(bin, 'pg_ctl'), ['-D', data, '-m', 'fast', '-w', 'stop'], { timeout: 30000 });
    started = false;
    rmSync(root, { recursive: true, force: true }); // only this freshly created synthetic fixture tree
  };
  try {
    const version = (await exec(join(bin, 'postgres'), ['--version'])).stdout;
    if (!/ 16\./.test(version)) throw new Error('Recovery rehearsal requires PostgreSQL 16 server tools (set PGBIN).');
    await exec(join(bin, 'initdb'), ['-D', data, '-U', 'postgres', '--encoding=UTF8', '--locale=C', '--auth-host=scram-sha-256', '--auth-local=trust', `--pwfile=${pw}`], {
      timeout: 30000,
    });
    const probe = createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', resolve);
    });
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
    // pg_ctl owns the background process and waits for readiness; generated log output stays in the fixture directory.
    await exec(join(bin, 'pg_ctl'), ['-D', data, '-l', join(root, 'postgres.log'), '-w', '-o', `-p ${port} -h 127.0.0.1 -k ${sockets}`, 'start'], { timeout: 30000 });
    started = true;
    return { url: `postgresql://postgres:rehearsal-only-password@127.0.0.1:${port}/postgres`, stop };
  } catch {
    // pg_ctl may have started before its wait timed out. Probe ownership via this data directory before cleanup.
    try {
      await exec(join(bin, 'pg_ctl'), ['-D', data, 'status']);
      started = true;
    } catch {
      /* not running */
    }
    await stop();
    throw new Error('Could not initialize the isolated recovery target; check PostgreSQL 16 server tools and loopback access.');
  }
}
