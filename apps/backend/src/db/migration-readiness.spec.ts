import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMigrations, migrationReadiness, type Queryable } from './migrator';

// The module object the migrator itself calls: `import * as fs` would hand back a copy, and a spy on a copy sees nothing.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require('node:fs') as typeof import('node:fs');

// /ready is public and is asked on every health probe and by anyone who finds it, and it used to read every migration file and hash them on each call
// (blocking the event loop on the synchronous reads). The files of a running image cannot change, so they are read once.

/** A database whose history is the first `applied` of the given migrations, as `migrationReadiness` reads it. */
function database(known: ReturnType<typeof loadMigrations>, applied: number): Queryable {
  return {
    query: (async (text: string) => {
      if (text.includes('to_regclass')) return { rows: [{ present: true }] };
      if (text.includes('FROM schema_migrations')) return { rows: known.slice(0, applied).map(({ version, name, checksum }) => ({ version, name, checksum })) };
      return { rows: [] };
    }) as Queryable['query'],
  };
}

const created: string[] = [];
afterAll(() => created.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
afterEach(() => jest.restoreAllMocks());

describe('migrationReadiness reads the shipped migration files once', () => {
  const shipped = loadMigrations();

  it('does not touch the migration directory again after the first answer, however often it is asked', async () => {
    const db = database(shipped, shipped.length);
    await migrationReadiness(db); // warm-up: the first call may read
    const readdir = jest.spyOn(fs, 'readdirSync');
    const readFile = jest.spyOn(fs, 'readFileSync');
    for (let i = 0; i < 25; i += 1) await migrationReadiness(db);
    expect(readdir).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  });

  it('still answers from the database every time: pending versions follow the history, not the cache', async () => {
    expect((await migrationReadiness(database(shipped, shipped.length))).pending).toEqual([]);
    expect((await migrationReadiness(database(shipped, shipped.length - 2))).pending).toEqual(shipped.slice(-2).map((m) => m.version));
    expect((await migrationReadiness(database(shipped, shipped.length))).pending).toEqual([]);
  });

  it('still refuses a history that disagrees with the files', async () => {
    const tampered = shipped.map((m, i) => (i === 3 ? { ...m, checksum: 'f'.repeat(64) } : m));
    await expect(migrationReadiness(database(tampered, shipped.length))).rejects.toThrow(/modified after it was applied/);
  });

  it('does not cache a directory it was given (control: a changed directory is read again)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'readiness-cache-'));
    created.push(dir);
    writeFileSync(join(dir, '0001_one.up.sql'), 'SELECT 1;\n');
    writeFileSync(join(dir, '0001_one.down.sql'), 'SELECT 1;\n');
    const empty: Queryable = { query: (async (text: string) => (text.includes('to_regclass') ? { rows: [{ present: false }] } : { rows: [] })) as Queryable['query'] };
    expect((await migrationReadiness(empty, dir)).pending).toEqual(['0001']);
    writeFileSync(join(dir, '0002_two.up.sql'), 'SELECT 2;\n');
    writeFileSync(join(dir, '0002_two.down.sql'), 'SELECT 2;\n');
    expect((await migrationReadiness(empty, dir)).pending).toEqual(['0001', '0002']);
  });
});
