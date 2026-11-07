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

/**
 * The desktop sidebar's width in rem, when the person has dragged it (specs/034 D8). Anything missing, unreadable or out of bounds reads as the default,
 * so a stored value can never make the sidebar unusable.
 */
const WIDTH_KEY = 'telesphoros.sidebar-width';
export const SIDEBAR_WIDTH = { min: 14, max: 24, default: 17, step: 0.5 } as const;

export function clampSidebarWidth(rem: number): number {
  return Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, Math.round(rem / SIDEBAR_WIDTH.step) * SIDEBAR_WIDTH.step));
}

export function readSidebarWidth(): number {
  try {
    const stored = Number(preferenceStorage.read(WIDTH_KEY));
    return Number.isFinite(stored) && stored >= SIDEBAR_WIDTH.min && stored <= SIDEBAR_WIDTH.max ? stored : SIDEBAR_WIDTH.default;
  } catch {
    return SIDEBAR_WIDTH.default;
  }
}

export function writeSidebarWidth(rem: number): void {
  try {
    preferenceStorage.write(WIDTH_KEY, rem === SIDEBAR_WIDTH.default ? null : String(rem));
  } catch {
    // Not kept: the width still applies until the page is reloaded.
  }
}
