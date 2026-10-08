import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AccountNotReadyError, useAuth } from '@/auth/AuthProvider';
import { Alert } from '@/components/ui/Alert';
import { AlertDescription } from '@/components/ui/AlertDescription';
import { AlertTitle } from '@/components/ui/AlertTitle';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import { usePageTitle } from '@/hooks/usePageTitle';

/** The address the sign-in page sends the browser back to. Redeems the one-time code, then moves on. */
export default function AuthCallbackPage() {
  usePageTitle('Signing you in');
  const { completeSignIn } = useAuth();
  const navigate = useNavigate();
  const [failure, setFailure] = useState<'none' | 'generic' | 'account'>('none');

  useEffect(() => {
    let cancelled = false;
    completeSignIn().then(
      // `replace`: the one-time code in this URL must not stay in the browser history.
      (returnTo) => !cancelled && navigate(returnTo, { replace: true }),
      (error: unknown) => {
        // The one-time code and state must not stay in the address bar or history after a failure either.
        window.history.replaceState(window.history.state, '', window.location.pathname);
        if (!cancelled) setFailure(error instanceof AccountNotReadyError ? 'account' : 'generic');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [completeSignIn, navigate]);

  if (failure === 'account') {
    return (
      <div className="flex max-w-prose flex-col gap-4">
        <h1 className="text-3xl leading-tight font-bold">Your account is not set up yet</h1>
        <Alert variant="destructive">
          <AlertTitle>No organization is assigned to your account</AlertTitle>
          <AlertDescription>
            You signed in successfully, but your account does not belong to an organization yet. Ask your administrator to add you to one. Trying again will not help until they do.
          </AlertDescription>
        </Alert>
      </div>
    );
  }
  if (failure === 'generic') {
    return (
      <div className="flex max-w-prose flex-col gap-4">
        <h1 className="text-3xl leading-tight font-bold">Sign-in did not complete</h1>
        <Alert variant="destructive">
          <AlertTitle>We could not sign you in</AlertTitle>
          <AlertDescription>The sign-in link may have expired or been used already. Please try again.</AlertDescription>
        </Alert>
        <div>
          <Button asChild>
            <Link to="/signin">Try again</Link>
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex max-w-prose flex-col gap-4">
      <h1 className="text-3xl leading-tight font-bold">Signing you in</h1>
      <p role="status" className="flex items-center gap-2 text-muted-foreground">
        <Spinner /> Please wait…
      </p>
    </div>
  );
}
