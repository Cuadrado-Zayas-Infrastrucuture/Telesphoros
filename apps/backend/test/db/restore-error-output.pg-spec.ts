import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { createBackup } from '../../src/db/backup';
import { pgEnv, run } from '../../src/db/pg-process';
import { restoreAndVerify } from '../../src/db/restore';
import { describeRestoreFailure } from '../../src/db/restore-failure';
import { adminUrl, createEphemeralDatabase, serializeRestoreSuites, withAdmin } from '../helpers/database';

/**
 * A failing restore must not put row values in front of the operator (and so into the log the drill or job writes). PostgreSQL's data-load errors
 * quote the key (`Key (tenant_id, label)=(...) already exists`) and the COPY context quotes the row itself.
 */
jest.setTimeout(120_000);
serializeRestoreSuites();

const TENANT = 'tenant-leakmark';
const LABEL = 'SYN-LEAKMARK-4242';
const leaked = (text: string) => text.includes(TENANT) || text.includes(LABEL) || text.includes('LEAKMARK');

/** Exactly what PostgreSQL 16 printed for a unique violation while `pg_restore` loaded the patients table (observed, with synthetic values). */
const OBSERVED_COPY_FAILURE = `pg_restore: error: COPY failed for table "patients": ERROR:  duplicate key value violates unique constraint "patients_label_uq"
DETAIL:  Key (tenant_id, label)=(${TENANT}, ${LABEL}) already exists.
CONTEXT:  PL/pgSQL function public.leakprobe_refuse() line 2 at RAISE
COPY patients, line 1: "1\t27dd3760-aebe-48ad-b364-ea6af77c716e\t${TENANT}\t${LABEL}\t2026-10-23 11:24:29.720035-..."
`;

describe('the restore check when pg_restore fails while loading data', () => {
  it('shows the operator the failing table and no row values, through the real restore code path', async () => {
    const db = await createEphemeralDatabase();
    const bin = mkdtempSync(join(tmpdir(), 'fake-pg-restore-'));
    const dest = mkdtempSync(join(tmpdir(), 'restore-error-output-'));
    const originalPath = process.env.PATH;
    try {
      await withAdmin(db.adminUrl, (c) => c.query(`INSERT INTO patients (tenant_id, created_by, label) VALUES ($1, 'syn', $2)`, [TENANT, LABEL]));
      const { dir } = await createBackup({ adminUrl: db.adminUrl, destDir: dest });
      // A stand-in `pg_restore` that fails the way the real one did (the real tool is exercised below), found first on PATH.
      writeFileSync(join(bin, 'pg_restore'), `#!/bin/sh\ncat >&2 <<'EOF'\n${OBSERVED_COPY_FAILURE}EOF\nexit 1\n`);
      chmodSync(join(bin, 'pg_restore'), 0o755);
      process.env.PATH = `${bin}:${originalPath}`;
      const report = await restoreAndVerify({ allowUnauthenticated: true, adminUrl: adminUrl(), backupDir: dir });
      const check = report.checks.find((c) => c.name === 'pg_restore')!;
      expect(check.ok).toBe(false); // the stand-in was the one that ran
      expect(check.detail).toContain('patients');
      expect(leaked(check.detail)).toBe(false);
      expect(report.checks.map((c) => c.detail).some(leaked)).toBe(false);
    } finally {
      process.env.PATH = originalPath;
      rmSync(bin, { recursive: true, force: true });
      rmSync(dest, { recursive: true, force: true });
      await db.drop();
    }
  });
});

describe('describeRestoreFailure on the real pg_restore', () => {
  const urlFor = (database: string) => {
    const u = new URL(adminUrl());
    u.pathname = `/${database}`;
    return u.toString();
  };
  const on = async (database: string, sql: string) => {
    const c = new Client({ connectionString: urlFor(database) });
    await c.connect();
    try {
      await c.query(sql);
    } finally {
      await c.end();
    }
  };

  async function failingRestore(extra: string[]): Promise<Error> {
    const id = Math.random().toString(16).slice(2, 10);
    const [source, target] = [`leak_src_${id}`, `leak_dst_${id}`];
    const work = mkdtempSync(join(tmpdir(), 'real-pg-restore-'));
    const dump = join(work, 'x.dump');
    const schema = 'CREATE TABLE people (tenant_id text NOT NULL, label text NOT NULL, UNIQUE (tenant_id, label))';
    const row = `INSERT INTO people VALUES ('${TENANT}', '${LABEL}')`;
    try {
      await withAdmin(adminUrl(), (c) => c.query(`CREATE DATABASE ${source}`));
      await withAdmin(adminUrl(), (c) => c.query(`CREATE DATABASE ${target}`));
      await on(source, `${schema}; ${row}`);
      await on(target, `${schema}; ${row}`); // the same row is already there, so loading the data hits the unique key
      const dumped = spawnSync('pg_dump', ['--format=custom', `--file=${dump}`], { env: pgEnv(adminUrl(), source), encoding: 'utf8' });
      expect(dumped.status).toBe(0);
      return await run('pg_restore', ['--exit-on-error', ...extra, `--dbname=${target}`, dump], pgEnv(adminUrl(), target)).then(
        () => { throw new Error('the restore was expected to fail'); },
        (error: Error) => error,
      );
    } finally {
      await withAdmin(adminUrl(), (c) => c.query(`DROP DATABASE IF EXISTS ${source} WITH (FORCE)`));
      await withAdmin(adminUrl(), (c) => c.query(`DROP DATABASE IF EXISTS ${target} WITH (FORCE)`));
      rmSync(work, { recursive: true, force: true });
    }
  }

  it('control: the raw error of a data-load failure does quote the row; the described one does not and still names the table', async () => {
    const error = await failingRestore(['--data-only']);
    expect(leaked(error.message)).toBe(true); // the setup really produces row text, so the assertion below can fail
    const described = describeRestoreFailure(error);
    expect(leaked(described)).toBe(false);
    expect(described).toContain('people');
    expect(described).toMatch(/^pg_restore exited with code 1/);
  });

  it('a failure creating objects keeps its first error line, which is schema text', async () => {
    const error = await failingRestore([]); // not data-only: the table already exists in the target
    const described = describeRestoreFailure(error);
    expect(described).toMatch(/already exists/);
    expect(described).not.toMatch(/Command was|CONTEXT|DETAIL/);
    expect(leaked(described)).toBe(false);
  });
});
