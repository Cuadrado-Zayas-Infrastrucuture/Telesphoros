import { ensureMigratedTemplate } from './database';

/** Builds the migrated template before any spec runs, so the first fixture of a run does not spend its test's deadline on migrations. */
export default async function globalSetup(): Promise<void> {
  if (process.env.TEST_DATABASE_URL) await ensureMigratedTemplate();
}
