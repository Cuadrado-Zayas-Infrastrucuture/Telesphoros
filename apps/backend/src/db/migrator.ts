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

/**
 * What a migration promises about code that does not know it yet.
 * `expand`: code from any release since the last `breaking` migration keeps working once it is applied (additive only: new tables,
 * new nullable columns, new indexes). `breaking`: anything else. A migration with no label is `breaking`.
 */
export type Compat = 'expand' | 'breaking';
const COMPAT_VALUES: readonly string[] = ['expand', 'breaking'];

export interface Migration {
  version: string;
  name: string;
  upSql: string;
  downSql: string;
  compat: Compat;
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

/**
 * Reads the `-- compat: expand|breaking` line from the leading comment block of an `.up.sql` (blank lines and `--` comments before the
 * first statement). A label anywhere else is ignored. An unknown value or a second label is an error, so a typo cannot quietly
 * become `breaking` (or worse, `expand`). The file is part of the checksum, so a label cannot change after the migration is applied.
 */
export function parseCompat(version: string, upSql: string): Compat {
  let found: Compat | undefined;
  for (const raw of upSql.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    if (!line.startsWith('--')) break;
    const match = /^--\s*compat:\s*(.*)$/.exec(line);
    if (!match) continue;
    const value = match[1]!.trim();
    if (!COMPAT_VALUES.includes(value)) throw new MigrationError(`Migration ${version} has an unknown compat label (use expand or breaking)`);
    if (found) throw new MigrationError(`Migration ${version} has more than one compat label`);
    found = value as Compat;
  }
  return found ?? 'breaking';
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
    return { version, name, upSql: up, downSql: down, compat: parseCompat(version, up), checksum };
  });
}

async function ensureTable(db: Queryable) {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    text PRIMARY KEY,
    name       text NOT NULL,
    checksum   text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  // Added in place, not by a numbered migration: the migrator owns this table. Checked first because ALTER TABLE takes an exclusive lock
  // even when the column exists, and /ready reads this table. Rows applied before the column existed stay NULL, which means `breaking`.
  const { rows } = await db.query(
    `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'schema_migrations' AND column_name = 'compat'`,
  );
  if (rows.length === 0) {
    // No CHECK constraint: readiness trusts only the exact text 'expand', so any other value already reads as breaking.
    await db.query('ALTER TABLE schema_migrations ADD COLUMN compat text');
  }
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

async function readCompat(db: Queryable, versions: string[]): Promise<Map<string, string | null>> {
  const column = await db.query(
    `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'schema_migrations' AND column_name = 'compat'`,
  );
  // No column: only an older migrator has touched this database, so nothing newer than this code was recorded with a label.
  if (column.rows.length === 0) return new Map();
  const { rows } = await db.query<{ version: string; compat: string | null }>(
    'SELECT version, compat FROM schema_migrations WHERE version = ANY($1::text[])',
    [versions],
  );
  return new Map(rows.map((row) => [row.version, row.compat]));
}

export interface MigrationReadiness {
  /** Known to this code but not applied yet (the database is behind the code). */
  pending: string[];
  /** Applied but unknown to this code, and all declared `expand` (the database is ahead of the code, safely). */
  tolerated: string[];
}

/**
 * What /ready asks: may this code serve against this database? Read-only. Stricter than it looks, and every refusal is a throw:
 * - the history this code knows must match the database exactly (version, order, checksum), so drift or a gap is refused;
 * - history this code does not know is tolerated only if it continues the numbering and EVERY such migration is labeled `expand`
 *   in the database. A `breaking`, unlabeled or unreadable label is refused, so a rolling deploy overlaps only across additive changes.
 * Pending migrations are reported, not tolerated: the caller refuses them. The migrator itself (`migrateUp`, `migrateDown`,
 * `migrationStatus`) stays strict and still refuses any history it does not know.
 */
let shipped: Migration[] | undefined;

/**
 * The migrations in this image's own directory, read and hashed once. /ready is public and is asked on every health probe, and `loadMigrations` reads every file
 * with synchronous calls, which blocks the event loop for each request. The files of a running image cannot change (read-only root filesystem), so the answer cannot
 * go stale. Only the default directory is kept: a directory a caller names is read each time, as before.
 */
function shippedMigrations(): Migration[] {
  return (shipped ??= loadMigrations());
}

export async function migrationReadiness(db: Queryable, dir?: string): Promise<MigrationReadiness> {
  const known = dir === undefined ? shippedMigrations() : loadMigrations(dir);
  const applied = await readApplied(db);
  verifyHistory(applied.slice(0, known.length), known);
  const newer = applied.slice(known.length);
  if (newer.length > 0) {
    newer.forEach((row, index) => {
      const expected = String(known.length + index + 1).padStart(4, '0');
      if (row.version !== expected) throw new MigrationError(`Database history after ${known.length} is not contiguous (found ${row.version})`);
    });
    const labels = await readCompat(db, newer.map((row) => row.version));
    const blocked = newer.filter((row) => labels.get(row.version) !== 'expand');
    if (blocked.length > 0) {
      throw new MigrationError(`Database has migration ${blocked[0]!.version} that this code does not know and that is not declared expand`);
    }
  }
  return { pending: known.slice(applied.length).map((migration) => migration.version), tolerated: newer.map((row) => row.version) };
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
        await client.query('INSERT INTO schema_migrations (version, name, checksum, compat) VALUES ($1, $2, $3, $4)', [
          migration.version,
          migration.name,
          migration.checksum,
          migration.compat,
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
