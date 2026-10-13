import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Client } from 'pg';

/** `migrations/` sits next to `src/` and `dist/`, so this resolves from both. */
export const MIGRATIONS_DIR = resolve(__dirname, '../../migrations');

// Any constant works; it only has to be the same for every runner so they queue on one lock.
const ADVISORY_LOCK_KEY = 7262001;
const FILE_NAME = /^(\d{4})_([a-z0-9_]+)\.(up|down)\.sql$/;

export class MigrationError extends Error {}

export interface Migration {
  version: string;
  name: string;
  upSql: string;
  downSql: string;
  /** Hash of the files as written. If an applied migration is edited later, the next run refuses. */
  checksum: string;
}

export interface AppliedMigration {
  version: string;
  name: string;
  checksum: string;
}

/** Anything with a pg-style `query`: a Client, a Pool or a PoolClient. */
export interface Queryable {
  query<R = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: R[] }>;
}

/** Reads `NNNN_name.up.sql` / `NNNN_name.down.sql` pairs and checks they are complete and contiguous. */
export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  const parts = new Map<string, { name: string; up?: string; down?: string }>();
  for (const file of readdirSync(dir).sort()) {
    const match = FILE_NAME.exec(file);
    if (!match) continue;
    const [, version, name, direction] = match as unknown as [string, string, string, 'up' | 'down'];
    const entry = parts.get(version) ?? { name };
    if (entry.name !== name) throw new MigrationError(`Migration ${version} has two different names`);
    entry[direction] = readFileSync(join(dir, file), 'utf8');
    parts.set(version, entry);
  }

  const versions = [...parts.keys()].sort();
  versions.forEach((version, index) => {
    if (Number(version) !== index + 1) {
      throw new MigrationError(`Migration versions must be contiguous from 0001; found a gap at ${version}`);
    }
  });
  return versions.map((version) => {
    const { name, up, down } = parts.get(version)!;
    if (up === undefined || down === undefined) {
      throw new MigrationError(`Migration ${version} needs both an .up.sql and a .down.sql file`);
    }
    const checksum = createHash('sha256').update(up).update('\0').update(down).digest('hex');
    return { version, name, upSql: up, downSql: down, checksum };
  });
}

async function ensureTable(db: Queryable) {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    text PRIMARY KEY,
    name       text NOT NULL,
    checksum   text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
}

async function readApplied(db: Queryable): Promise<AppliedMigration[]> {
  const exists = await db.query<{ present: boolean }>(`SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present`);
  if (!exists.rows[0]?.present) return [];
  const { rows } = await db.query<AppliedMigration>('SELECT version, name, checksum FROM schema_migrations ORDER BY version');
  return rows;
}

/** Refuses to continue if the database and the files disagree about history. */
function verifyHistory(applied: AppliedMigration[], known: Migration[]) {
  applied.forEach((row, index) => {
    const migration = known[index];
    if (!migration || migration.version !== row.version) {
      throw new MigrationError(`Database has migration ${row.version} that this code does not know (or its order differs)`);
    }
    if (migration.checksum !== row.checksum) {
      throw new MigrationError(`Migration ${row.version} was modified after it was applied. Add a new migration instead.`);
    }
  });
}

export async function migrationStatus(db: Queryable, dir?: string) {
  const known = loadMigrations(dir);
  const applied = await readApplied(db);
  verifyHistory(applied, known);
  return { applied, pending: known.slice(applied.length) };
}

/** Validates recorded history before returning the pending suffix. Read-only; invalid or newer history throws. */
export async function pendingMigrations(db: Queryable, dir?: string): Promise<string[]> {
  const { pending } = await migrationStatus(db, dir);
  return pending.map((migration) => migration.version);
}

async function withLock<T>(client: Client, work: () => Promise<T>): Promise<T> {
  // Two deploys starting together must not both run DDL: the second waits here, then finds nothing pending.
  await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
  try {
    return await work();
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]);
  }
}

async function inTransaction(client: Client, version: string, work: () => Promise<void>) {
  await client.query('BEGIN');
  try {
    await work();
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw new MigrationError(`Migration ${version} failed and was rolled back: ${(error as Error).message}`);
  }
}

/** Applies every pending migration in order, each in its own transaction. Returns the versions applied. */
export async function migrateUp(client: Client, dir?: string): Promise<string[]> {
  const known = loadMigrations(dir);
  return withLock(client, async () => {
    await ensureTable(client);
    const applied = await readApplied(client);
    verifyHistory(applied, known);
    const done: string[] = [];
    for (const migration of known.slice(applied.length)) {
      await inTransaction(client, migration.version, async () => {
        await client.query(migration.upSql);
        await client.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [
          migration.version,
          migration.name,
          migration.checksum,
        ]);
      });
      done.push(migration.version);
    }
    return done;
  });
}

/** Reverts the most recent `steps` migrations (default 1). Returns the versions reverted, newest first. */
export async function migrateDown(client: Client, steps = 1, dir?: string): Promise<string[]> {
  const known = loadMigrations(dir);
  return withLock(client, async () => {
    await ensureTable(client);
    const applied = await readApplied(client);
    verifyHistory(applied, known);
    const done: string[] = [];
    for (const row of applied.slice().reverse().slice(0, steps)) {
      const migration = known.find((m) => m.version === row.version)!;
      await inTransaction(client, migration.version, async () => {
        await client.query(migration.downSql);
        await client.query('DELETE FROM schema_migrations WHERE version = $1', [migration.version]);
      });
      done.push(migration.version);
    }
    return done;
  });
}
