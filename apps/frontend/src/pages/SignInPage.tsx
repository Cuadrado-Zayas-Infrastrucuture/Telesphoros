import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '@/auth/AuthProvider';
import { safeReturnTo } from '@/auth/returnTo';
import { Alert } from '@/components/ui/Alert';
import { AlertDescription } from '@/components/ui/AlertDescription';
import { AlertTitle } from '@/components/ui/AlertTitle';
import { SignInArt } from '@/components/signin/SignInArt';
import { Button } from '@/components/ui/Button';
import { usePageTitle } from '@/hooks/usePageTitle';

export default function SignInPage() {
  usePageTitle('Sign in');
  const { signIn } = useAuth();
  const location = useLocation();
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const returnTo = safeReturnTo((location.state as { returnTo?: unknown } | null)?.returnTo);

  async function start() {
    setBusy(true);
    setError(false);
    try {
      await signIn(returnTo); // navigates away to the secure sign-in page
    } catch {
      setError(true);
      setBusy(false);
    }
  }

  return (
    <div className="grid items-center gap-10 lg:grid-cols-2">
      <div className="flex max-w-prose flex-col gap-4">
        <h1 className="font-sans text-4xl leading-tight font-medium tracking-tight">Sign in</h1>
        <p className="text-muted-foreground">You will be taken to the secure sign-in page. Accounts are by invitation only: if you need access, ask your administrator.</p>
        {error && (
          <Alert variant="destructive">
            <AlertTitle>Could not reach the sign-in page</AlertTitle>
            <AlertDescription>Check your connection and try again.</AlertDescription>
          </Alert>
        )}
        <div>
          <Button size="lg" onClick={start} pending={busy} pendingLabel="Redirecting…" disabled={busy}>
            Sign in
          </Button>
        </div>
      </div>
      {/* Decoration only: a drawing made in code, with no data in it. Hidden from assistive technology. */}
      <div className="h-72 sm:h-96 lg:h-128">
        <SignInArt />
      </div>
    </div>
  );
}
