import { copyFileSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MIGRATIONS_DIR } from '../../src/db/migrator';

/** A copy of the shipped migrations up to and including `version`, for a test about one migration that must not also apply the ones after it. */
export function migrationsThrough(version: string): string {
  const dir = mkdtempSync(join(tmpdir(), `migrations-${version}-`));
  for (const file of readdirSync(MIGRATIONS_DIR)) if (/^\d{4}_/.test(file) && file.slice(0, 4) <= version) copyFileSync(join(MIGRATIONS_DIR, file), join(dir, file));
  return dir;
}
