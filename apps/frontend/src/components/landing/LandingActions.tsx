import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useLandingLanguage } from '@/lib/landing/landing-language';

export function LandingActions({ canUpload, signedIn, reveal }: { canUpload: boolean; signedIn: boolean; reveal?: number }) {
  const { actions } = useLandingLanguage().copy;
  return (
    <div className="landing-actions" data-reveal={reveal}>
      {canUpload ? (
        <Button asChild className="landing-primary">
          <Link to="/reports/upload">
            {actions.upload}
            <ArrowRight aria-hidden="true" className="size-4" />
          </Link>
        </Button>
      ) : !signedIn ? (
        <Button asChild className="landing-primary">
          <Link to="/signin">
            {actions.signIn}
            <ArrowRight aria-hidden="true" className="size-4" />
          </Link>
        </Button>
      ) : (
        <Button asChild className="landing-primary">
          <a href="#workflow">
            {actions.explore}
            <ArrowRight aria-hidden="true" className="size-4" />
          </a>
        </Button>
      )}
      <a className="landing-secondary" href="#workflow">
        {actions.how}
        <span aria-hidden="true">↓</span>
      </a>
    </div>
  );
}
