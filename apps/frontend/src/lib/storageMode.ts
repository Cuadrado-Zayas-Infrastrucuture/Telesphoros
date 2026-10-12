/** Build-time opt-in. The API independently enforces ownership and disabled processing. */
export function ownedStorageMode(): boolean {
  const setting = import.meta.env.VITE_LOCAL_STORAGE_INTAKE;
  if (setting !== undefined && setting !== '' && setting !== 'true' && setting !== 'false') throw new Error('Invalid local storage intake setting.');
  return setting === 'true';
}
export function assertOwnedStorageBrowser(): void {
  if (!ownedStorageMode() || import.meta.env.MODE === 'production' || window.location.hostname !== '127.0.0.1') {
    throw new Error('Owned storage requires a local browser build.');
  }
}
