import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { usePageTitle } from '@/hooks/usePageTitle';

export default function SignedOutPage() {
  usePageTitle('Signed out');
  return (
    <div className="flex max-w-prose flex-col gap-4">
      <h1 className="font-sans text-4xl leading-tight font-medium tracking-tight">You have been signed out</h1>
      <p className="text-muted-foreground">Close this window, or sign in again to continue.</p>
      <div>
        <Button asChild>
          <Link to="/signin">Sign in</Link>
        </Button>
      </div>
    </div>
  );
}
