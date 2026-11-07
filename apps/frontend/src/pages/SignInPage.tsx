import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '@/auth/AuthProvider';
import { safeReturnTo } from '@/auth/returnTo';
import { Alert } from '@/components/ui/Alert';
import { AlertDescription } from '@/components/ui/AlertDescription';
import { AlertTitle } from '@/components/ui/AlertTitle';
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
    <div className="flex max-w-prose flex-col gap-4">
      <h1 className="text-3xl leading-tight font-bold">Sign in</h1>
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
  );
}
