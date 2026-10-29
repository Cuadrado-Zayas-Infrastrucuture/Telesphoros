import type { Role } from '@telesphoros/shared-types';
import { ADMIN_ROLES, CLINICAL_READ_ROLES } from '@/auth/roles';

export const LOCAL_WORKSPACE_PATH = '/local-workspace';

/**
 * The one-screen workspace exists only in a development build served on this machine: its route is compiled out of production
 * (app/routes.tsx), and its upload path and sample answers refuse to run anywhere else. Same test as the page and the sidebar.
 */
export function localWorkspaceAvailable(): boolean {
  return import.meta.env.DEV && location.hostname === '127.0.0.1';
}

/** Where "Open workspace" goes. The local preview's home is the workspace (specs/022); otherwise the first page this person can use. */
export function signedInHome(roles: readonly Role[]): string {
  if (localWorkspaceAvailable()) return LOCAL_WORKSPACE_PATH;
  if (roles.some((role) => CLINICAL_READ_ROLES.includes(role))) return '/reports';
  if (roles.some((role) => ADMIN_ROLES.includes(role))) return '/usage';
  return '/settings';
}

/** Where signing in lands. In the local preview, signing in from the bare home page opens the workspace; any deeper path is kept. */
export function landingAfterSignIn(returnTo: string): string {
  return returnTo === '/' && localWorkspaceAvailable() ? LOCAL_WORKSPACE_PATH : returnTo;
}
