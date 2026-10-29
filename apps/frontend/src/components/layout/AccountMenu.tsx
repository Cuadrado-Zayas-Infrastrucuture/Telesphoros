import { Link } from 'react-router-dom';
import type { Role } from '@telesphoros/shared-types';
import { ADMIN_ROLES, CLINICAL_READ_ROLES } from '@/auth/roles';
import { useAuth } from '@/auth/AuthProvider';
import { Button } from '@/components/ui/Button';
import { useShellCopy } from '@/lib/landing/landing-language';

/** Where "Open workspace" goes: the first page this person can use. */
function workspaceHome(roles: readonly Role[]): string {
  if (roles.some((role) => CLINICAL_READ_ROLES.includes(role))) return '/reports';
  if (roles.some((role) => ADMIN_ROLES.includes(role))) return '/usage';
  return '/settings';
}

/**
 * The site header's account control: Sign in, or, once signed in, the way back into the workspace. Signing out lives in the workspace
 * sidebar and in Settings (specs/018-unified-sidebar), not in the header.
 */
export function AccountMenu() {
  const { status, roles } = useAuth();
  const { header } = useShellCopy();
  return (
    <Button asChild variant="outline">
      {status === 'signedIn' ? <Link to={workspaceHome(roles)}>{header.openWorkspace}</Link> : <Link to="/signin">{header.signIn}</Link>}
    </Button>
  );
}
