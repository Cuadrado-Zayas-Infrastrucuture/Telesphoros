/** Build-time opt-in. The API independently enforces ownership and disabled processing. */
export function ownedStorageMode(): boolean {
  const setting = import.meta.env.VITE_LOCAL_STORAGE_INTAKE;
  if (setting !== undefined && setting !== '' && setting !== 'true' && setting !== 'false') throw new Error('Invalid local storage intake setting.');
  return setting === 'true';
}

/**
 * Build-time opt-in for the synthetic staging: the review and assessment of stored structured reports on a deployed host. The API independently requires its
 * own SYNTHETIC_ASSESSMENT switch, so a build with this flag served anywhere else can do nothing. Never together with the owned-local build.
 */
export function syntheticStagingMode(): boolean {
  const setting = import.meta.env.VITE_SYNTHETIC_ASSESSMENT;
  if (setting !== undefined && setting !== '' && setting !== 'true' && setting !== 'false') throw new Error('Invalid synthetic assessment setting.');
  if (setting === 'true' && ownedStorageMode()) throw new Error('The synthetic staging build cannot also be the owned-local build.');
  return setting === 'true';
}
