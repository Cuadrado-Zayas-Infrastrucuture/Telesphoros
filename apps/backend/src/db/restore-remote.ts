import { makeTempDir } from './cleanup';
import { downloadBackup, latestComplete, OffsiteError, type ReadTarget, type RemoteLocation } from './offsite';
import { type RestoreOptions, type RestoreReport, restoreAndVerify } from './restore';

export interface RemoteRestoreOptions extends Omit<RestoreOptions, 'backupDir'> {
  /** A READ-ONLY credential's client. */
  client: ReadTarget['client'];
  location: RemoteLocation;
  /** When the location names no single backup: take the newest complete one. */
  latest?: boolean;
}

/**
 * Restores from the second provider: downloads into a private temp folder (removed however the process ends), then runs
 * the same verification as a local restore. Nothing is trusted from the remote: the manifest is validated and, with a
 * key file, its signature checked before the dump is even looked at.
 */
export async function restoreFromRemote(options: RemoteRestoreOptions): Promise<RestoreReport> {
  const { client, location, latest, ...restoreOptions } = options;
  const target: ReadTarget = { client, bucket: location.bucket, prefix: location.prefix };
  const database = restoreOptions.targetDatabase ?? 'restore_check';
  const failure = (detail: string): RestoreReport => ({ ok: false, database, kept: false, checks: [{ name: 'download', ok: false, detail }] });

  let name = location.backup;
  if (!name) {
    if (!latest) return failure('The remote names no single backup; give …/backup-<timestamp> or --latest.');
    const found = await latestComplete(target).catch(() => undefined);
    if (!found) return failure('No complete backup was found under that prefix (or it could not be listed).');
    name = found.name;
  }

  const download = makeTempDir('restore-dl-');
  try {
    try {
      await downloadBackup(target, name, download.path);
    } catch (error) {
      return failure(error instanceof OffsiteError ? error.message : `could not download ${name} (${(error as { name?: string }).name ?? 'error'})`);
    }
    const report = await restoreAndVerify({ ...restoreOptions, backupDir: download.path });
    report.checks.unshift({ name: 'download', ok: true, detail: `${name} from ${location.bucket}` });
    return report;
  } finally {
    download.dispose();
  }
}
