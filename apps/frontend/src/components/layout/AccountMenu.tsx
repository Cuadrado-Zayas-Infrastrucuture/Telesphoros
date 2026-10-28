import { Link } from 'react-router-dom';
import { primaryRole } from '@/auth/roles';
import { useAuth } from '@/auth/AuthProvider';
import { Button } from '@/components/ui/Button';
import { useShellCopy } from '@/lib/landing/landing-language';

/** Who is signed in (by role; the email is shown only in Settings) and the way out. */
export function AccountMenu() {
  const { status, roles, signOut } = useAuth();
  const { header } = useShellCopy();
  if (status !== 'signedIn') {
    return (
      <Button asChild variant="outline">
        <Link to="/signin">{header.signIn}</Link>
      </Button>
    );
  }
  return (
    <div className="flex items-center gap-2 sm:gap-3">
      <span className="text-xs text-muted-foreground sm:text-sm">
        <span className="hidden sm:inline">{header.signedInAs}</span>
        <strong className="text-foreground">{primaryRole(roles) ?? 'user with no role'}</strong>
      </span>
      <Button variant="outline" className="text-sm" onClick={() => void signOut()}>
        {header.signOut}
      </Button>
    </div>
  );
}
