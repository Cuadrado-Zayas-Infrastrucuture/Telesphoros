import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/Button';

export function LandingActions({ canUpload, signedIn, reveal }: { canUpload: boolean; signedIn: boolean; reveal?: number }) {
  return <div className="landing-actions" data-reveal={reveal}>
    {canUpload ? <Button asChild className="landing-primary"><Link to="/reports/upload">Upload a synthetic report<ArrowRight aria-hidden="true" className="size-4" /></Link></Button>
      : !signedIn ? <Button asChild className="landing-primary"><Link to="/signin">Sign in to Telesphoros<ArrowRight aria-hidden="true" className="size-4" /></Link></Button>
        : <Button asChild className="landing-primary"><a href="#workflow">Explore the workflow<ArrowRight aria-hidden="true" className="size-4" /></a></Button>}
    <a className="landing-secondary" href="#workflow">See how it works <span aria-hidden="true">↓</span></a>
  </div>;
}
