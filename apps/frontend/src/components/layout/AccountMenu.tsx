import { Link, useMatch } from 'react-router-dom';
import { useAuth } from '@/auth/AuthProvider';
import { Button } from '@/components/ui/Button';
import { useShellCopy } from '@/lib/landing/landing-language';
import { signedInHome } from '@/lib/localWorkspace';

/**
 * The site header's account control: Sign in, or, once signed in, the way back into the workspace. Signing out lives in the workspace
 * sidebar and in Settings (specs/018-unified-sidebar), not in the header.
 */
export function AccountMenu() {
  const { status, roles } = useAuth();
  const { header } = useShellCopy();
  const signInPage = useMatch('/signin');
  if (status !== 'signedIn' && signInPage) return null;
  return (
    <Button asChild variant="outline">
      {status === 'signedIn' ? <Link to={signedInHome(roles)}>{header.openWorkspace}</Link> : <Link to="/signin">{header.signIn}</Link>}
    </Button>
  );
}
