/**
 * Whether the desktop sidebar is collapsed to icons. Only this one word is stored, in this browser: it is a layout convenience, not data.
 * Browser storage can be missing or blocked; the sidebar then starts expanded.
 */
const STORAGE_KEY = 'telesphoros.sidebar';

export function readSidebarCollapsed(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'collapsed';
  } catch {
    return false;
  }
}

export function writeSidebarCollapsed(collapsed: boolean): void {
  try {
    if (collapsed) window.localStorage.setItem(STORAGE_KEY, 'collapsed');
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Not kept: the choice still applies until the page is reloaded.
  }
}
