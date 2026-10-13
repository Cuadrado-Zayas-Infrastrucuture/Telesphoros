import { Link } from 'react-router-dom';
import { primaryRole } from '@/auth/roles';
import { useAuth } from '@/auth/AuthProvider';
import { Button } from '@/components/ui/Button';

/** Who is signed in (by role only: no name or email is held) and the way out. */
export function AccountMenu() {
  const { status, roles, signOut } = useAuth();
  if (status !== 'signedIn') {
    return (
      <Button asChild variant="outline">
        <Link to="/signin">Sign in</Link>
      </Button>
    );
  }
  return (
    <div className="flex items-center gap-2 sm:gap-3">
      <span className="text-xs text-muted-foreground sm:text-sm">
        <span className="hidden sm:inline">Signed in as </span><strong className="text-foreground">{primaryRole(roles) ?? 'user with no role'}</strong>
      </span>
      <Button variant="outline" className="text-sm" onClick={() => void signOut()}>
        Sign out
      </Button>
    </div>
  );
}
