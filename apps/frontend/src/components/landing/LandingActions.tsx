import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { useAuth } from '@/auth/AuthProvider';
import { Button } from '@/components/ui/Button';
import { useLandingLanguage } from '@/lib/landing/landing-language';
import { signedInHome } from '@/lib/localWorkspace';

/**
 * The hero's actions. Signed in, the primary action opens Attach a report for a writer role (spec 052 RC-2: every attach control opens the
 * upload page), and the signed-in home, the worklist (spec 049), for anyone else.
 */
export function LandingActions({ canUpload, signedIn, reveal }: { canUpload: boolean; signedIn: boolean; reveal?: number }) {
  const { actions } = useLandingLanguage().copy;
  const { roles } = useAuth();
  return (
    <div className="landing-actions" data-reveal={reveal}>
      <Button asChild className="landing-primary">
        <Link to={!signedIn ? '/signin' : canUpload ? '/reports/upload' : signedInHome(roles)}>
          {!signedIn ? actions.signIn : canUpload ? actions.upload : actions.open}
          <ArrowRight aria-hidden="true" className="size-4" />
        </Link>
      </Button>
      <a className="landing-secondary" href="#platform">
        {actions.how}
        <span aria-hidden="true">↓</span>
      </a>
    </div>
  );
}
