import { loadMigrations } from '../../src/db/migrator';

/**
 * What a test may ask about the migration history without writing the history down. A spec that needs "everything after the
 * ledger migration" or "revert back past the report evidence" asks here, so adding a migration never means editing a spec.
 *
 * An anchor is a four-digit version ('0011'), a name ('ledger_incidents') or both ('0011_ledger_incidents'). Prefer the name: it
 * says what the test is about. An unknown anchor throws, so a renamed or removed migration fails loudly rather than selecting nothing.
 * The one place that pins history on purpose is test/migration-history.spec.ts.
 */
const versions = () => loadMigrations().map((migration) => migration.version);

function versionOf(anchor: string): string {
  const matches = loadMigrations().filter((m) => anchor === m.version || anchor === m.name || anchor === `${m.version}_${m.name}`);
  if (matches.length !== 1) throw new Error(`Migration anchor "${anchor}" matches ${matches.length} shipped migrations (use a version, a name or both)`);
  return matches[0]!.version;
}

/** Every shipped version, ascending. */
export const allVersions = (): string[] => versions();

/** The newest shipped version. */
export const lastVersion = (): string => versions().at(-1)!;

/** `anchor` and every later version, ascending: what `migrateUp` reports after a database was brought down to just before `anchor`. */
export const versionsFrom = (anchor: string): string[] => versions().filter((v) => v >= versionOf(anchor));

/** Every version after `anchor`, ascending. */
export const versionsAfter = (anchor: string): string[] => versions().filter((v) => v > versionOf(anchor));

/** Every version up to and including `anchor`, ascending. */
export const versionsThrough = (anchor: string): string[] => versions().filter((v) => v <= versionOf(anchor));

/** The step count and the exact list (newest first) `migrateDown` reverts to undo `anchor` and everything above it. */
export function revertThrough(anchor: string): { steps: number; reverted: string[] } {
  const reverted = versionsFrom(anchor).reverse();
  return { steps: reverted.length, reverted };
}

/** The same for everything strictly above `anchor`, leaving `anchor` applied. Empty (zero steps) when `anchor` is the newest. */
export function revertAbove(anchor: string): { steps: number; reverted: string[] } {
  const reverted = versionsAfter(anchor).reverse();
  return { steps: reverted.length, reverted };
}
