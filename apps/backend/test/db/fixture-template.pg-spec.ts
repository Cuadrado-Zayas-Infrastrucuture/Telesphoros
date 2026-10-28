import { execFileSync } from 'node:child_process';
import { loadMigrations, migrateUp } from '../../src/db/migrator';
import { adminUrl, createEphemeralDatabase, type EphemeralDatabase, migratedTemplateName, withAdmin } from '../helpers/database';

// Two fixtures, one of them migrated from empty, and two full dumps: the same 30 s budget as the other specs that migrate a database.
jest.setTimeout(30_000);

/**
 * Database fixtures are copies of one migrated template (test/helpers/database.ts). A copy must be the database a fresh migration builds:
 * same schema, owners, grants, policies and migration-seeded rows. If it were not, every database spec would test the template, not the
 * migrations.
 */
const fixtures: EphemeralDatabase[] = [];
afterAll(async () => {
  for (const db of fixtures) await db.drop();
});

// pg_dump's \restrict line carries a random key per dump; everything else must match.
const dump = (url: string, ...args: string[]) =>
  execFileSync('pg_dump', [...args, url], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n')
    .filter((line) => !/^\\(un)?restrict /.test(line))
    .join('\n');
const history = (url: string) => withAdmin(url, async (c) => (await c.query('SELECT version, name, checksum FROM schema_migrations ORDER BY version')).rows);
const schedules = (url: string) => withAdmin(url, async (c) => (await c.query('SELECT type, interval_seconds, max_attempts, enabled FROM job_schedules ORDER BY type')).rows);

describe('the migrated template', () => {
  it('is a copy of what a fresh migration builds: schema, owners, grants, policies and seeded rows', async () => {
    const fresh = await createEphemeralDatabase({ migrate: false });
    fixtures.push(fresh);
    await withAdmin(fresh.adminUrl, (c) => migrateUp(c));
    const copy = await createEphemeralDatabase();
    fixtures.push(copy);

    expect(dump(copy.adminUrl, '--schema-only')).toEqual(dump(fresh.adminUrl, '--schema-only'));
    // Two columns are stamped now() when a migration runs, so a copy carries the template's time: schema_migrations.applied_at and
    // job_schedules.created_at (0024 seeds two schedules; the scheduler reads only type, interval and attempts). Every other row must match,
    // and those two tables must match without their timestamp. A new migration that seeds another now() fails here until it is listed.
    const stamped = ['--exclude-table-data=schema_migrations', '--exclude-table-data=job_schedules'];
    expect(dump(copy.adminUrl, '--data-only', ...stamped)).toEqual(dump(fresh.adminUrl, '--data-only', ...stamped));
    expect(await history(copy.adminUrl)).toEqual(await history(fresh.adminUrl));
    expect(await schedules(copy.adminUrl)).toEqual(await schedules(fresh.adminUrl));
    expect((await history(copy.adminUrl)).length).toBe(loadMigrations().length);
  });

  it('is a template that accepts no connections, named outside the fixture prefix the leak control counts', async () => {
    fixtures.push(await createEphemeralDatabase());
    const name = migratedTemplateName();
    expect(name).not.toMatch(/^test_/);
    const row = await withAdmin(adminUrl(), async (c) => (await c.query('SELECT datistemplate, datallowconn FROM pg_database WHERE datname = $1', [name])).rows[0]);
    expect(row).toEqual({ datistemplate: true, datallowconn: false });
  });
});

describe('the template name', () => {
  const migrations = loadMigrations();

  it('is the same for the same migrations', () => {
    expect(migratedTemplateName(migrations)).toBe(migratedTemplateName(loadMigrations()));
  });

  it('changes when a migration is edited, added or removed, so a stale template is never copied', () => {
    const base = migratedTemplateName(migrations);
    const edited = migrations.map((m, i) => (i === migrations.length - 1 ? { ...m, checksum: `${m.checksum}x` } : m));
    const added = [...migrations, { version: '9999', checksum: 'synthetic' }];
    const removed = migrations.slice(0, -1);
    const names = [edited, added, removed].map((set) => migratedTemplateName(set));
    expect(new Set([base, ...names]).size).toBe(4);
  });
});
