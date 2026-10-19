import type { Database } from '../db/database';
import type { ReadinessCheck } from './readiness.service';

/** Not ready if the database is unreachable. */
export function databaseReachableCheck(db: Database): ReadinessCheck {
  return { name: 'database', check: () => db.ping() };
}

/**
 * Not ready with pending migrations or history that disagrees with this binary's versions/checksums. History NEWER than this binary
 * is accepted only when every newer migration is declared `expand` (see `migrationReadiness`); otherwise it is refused as before.
 */
export function migrationsAppliedCheck(db: Database): ReadinessCheck {
  return {
    name: 'migrations',
    check: async () => {
      const { pending } = await db.migrationReadiness();
      if (pending.length > 0) throw new Error(`pending migrations: ${pending.join(', ')}`);
    },
  };
}
