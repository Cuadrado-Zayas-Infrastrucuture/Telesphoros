import { preferenceStorage } from '@/lib/storageConsent';

/**
 * Whether the desktop sidebar is collapsed to icons. Only this one word is stored, in this browser: it is a layout convenience, not data.
 * Browser storage can be missing or blocked; the sidebar then starts expanded.
 */
const STORAGE_KEY = 'telesphoros.sidebar';

export function readSidebarCollapsed(): boolean {
  try {
    return preferenceStorage.read(STORAGE_KEY) === 'collapsed';
  } catch {
    return false;
  }
}

export function writeSidebarCollapsed(collapsed: boolean): void {
  try {
    if (collapsed) preferenceStorage.write(STORAGE_KEY, 'collapsed');
    else preferenceStorage.write(STORAGE_KEY, null);
  } catch {
    // Not kept: the choice still applies until the page is reloaded.
  }
}
