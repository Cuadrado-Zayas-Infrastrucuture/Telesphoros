import type { Role } from '@telesphoros/shared-types';
import { ADMIN_ROLES, CLINICAL_READ_ROLES, WRITER_ROLES } from '@/auth/roles';

export const LOCAL_WORKSPACE_PATH = '/local-workspace';

/**
 * The one-screen workspace exists only in a development build served on this machine: its route is compiled out of production
 * (app/routes.tsx), and its upload path and sample answers refuse to run anywhere else. Same test as the page and the sidebar.
 */
export function localWorkspaceAvailable(): boolean {
  return import.meta.env.DEV && location.hostname === '127.0.0.1';
}

export const WORKSPACE_PATH = '/workspace';

const canUseChat = (roles: readonly Role[]) => roles.some((role) => CLINICAL_READ_ROLES.includes(role) || WRITER_ROLES.includes(role));

/**
 * Where "Open workspace" goes. The local preview's home is its own workspace (specs/022); elsewhere, writer and clinical read roles open the chat home
 * (specs/024), an administrator with no clinical role the usage page, and anyone else their settings.
 */
export function signedInHome(roles: readonly Role[]): string {
  if (localWorkspaceAvailable()) return LOCAL_WORKSPACE_PATH;
  if (canUseChat(roles)) return WORKSPACE_PATH;
  if (roles.some((role) => ADMIN_ROLES.includes(role))) return '/usage';
  return '/settings';
}

/** Where signing in lands. Signing in from the bare home page opens the local workspace in the local preview and the chat home for clinical roles; any deeper path is kept. */
export function landingAfterSignIn(returnTo: string, roles: readonly Role[]): string {
  if (returnTo !== '/') return returnTo;
  if (localWorkspaceAvailable()) return LOCAL_WORKSPACE_PATH;
  return canUseChat(roles) ? WORKSPACE_PATH : returnTo;
}
