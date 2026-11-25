import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AccountNotReadyError, useAuth } from '@/auth/AuthProvider';
import { Alert } from '@/components/ui/Alert';
import { AlertDescription } from '@/components/ui/AlertDescription';
import { AlertTitle } from '@/components/ui/AlertTitle';
import { Button } from '@/components/ui/Button';
import { ContentSkeleton } from '@/components/ui/ContentSkeleton';
import { usePageTitle } from '@/hooks/usePageTitle';
import { landingAfterSignIn } from '@/lib/localWorkspace';
import { CALLBACK_WORDS } from '@/lib/words/signIn';
import { useWords } from '@/lib/words/screens';

/** The address the sign-in page sends the browser back to. Redeems the one-time code, then moves on. */
export default function AuthCallbackPage() {
  const words = useWords(CALLBACK_WORDS);
  usePageTitle(words.title);
  const { completeSignIn, roles } = useAuth();
  const navigate = useNavigate();
  const [returnTo, setReturnTo] = useState<string | null>(null);
  const [failure, setFailure] = useState<'none' | 'generic' | 'account'>('none');

  useEffect(() => {
    let cancelled = false;
    completeSignIn().then(
      (target) => !cancelled && setReturnTo(target),
      (error: unknown) => {
        // The one-time code and state must not stay in the address bar or history after a failure either.
        window.history.replaceState(window.history.state, '', window.location.pathname);
        if (!cancelled) setFailure(error instanceof AccountNotReadyError ? 'account' : 'generic');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [completeSignIn]);

  // The roles are set in the same step that resolves the sign-in, so they are current by the time this runs. `replace`: the one-time code in this URL must
  // not stay in the browser history.
  useEffect(() => {
    if (returnTo !== null) navigate(landingAfterSignIn(returnTo, roles), { replace: true });
  }, [returnTo, roles, navigate]);

  if (failure === 'account') {
    return (
      <div className="flex max-w-prose flex-col gap-4">
        <h1 className="font-sans text-4xl leading-tight font-medium tracking-tight">{words.accountHeading}</h1>
        <Alert variant="destructive">
          <AlertTitle>{words.accountTitle}</AlertTitle>
          <AlertDescription>{words.accountBody}</AlertDescription>
        </Alert>
      </div>
    );
  }
  if (failure === 'generic') {
    return (
      <div className="flex max-w-prose flex-col gap-4">
        <h1 className="font-sans text-4xl leading-tight font-medium tracking-tight">{words.failedHeading}</h1>
        <Alert variant="destructive">
          <AlertTitle>{words.failedTitle}</AlertTitle>
          <AlertDescription>{words.failedBody}</AlertDescription>
        </Alert>
        <div>
          <Button asChild>
            <Link to="/signin">{words.tryAgain}</Link>
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex max-w-prose flex-col gap-4">
      <h1 className="font-sans text-4xl leading-tight font-medium tracking-tight">{words.heading}</h1>
      <ContentSkeleton label={words.wait} variant="detail" />
    </div>
  );
}
