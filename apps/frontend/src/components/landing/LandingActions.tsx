import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { useAuth } from '@/auth/AuthProvider';
import { Button } from '@/components/ui/Button';
import { useLandingLanguage } from '@/lib/landing/landing-language';
import { signedInHome } from '@/lib/localWorkspace';

/** The hero's actions. Signed in, the primary action opens the signed-in home (the chat, specs/024 D1), where reports are attached. */
export function LandingActions({ canUpload, signedIn, reveal }: { canUpload: boolean; signedIn: boolean; reveal?: number }) {
  const { actions } = useLandingLanguage().copy;
  const { roles } = useAuth();
  return (
    <div className="landing-actions" data-reveal={reveal}>
      <Button asChild className="landing-primary">
        <Link to={signedIn ? signedInHome(roles) : '/signin'}>
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
