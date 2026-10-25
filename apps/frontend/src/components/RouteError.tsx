import { isRouteErrorResponse, Link, useRouteError } from 'react-router-dom';
import { Alert } from '@/components/ui/Alert';
import { AlertDescription } from '@/components/ui/AlertDescription';
import { AlertTitle } from '@/components/ui/AlertTitle';
import { Button } from '@/components/ui/Button';
import { usePageTitle } from '@/hooks/usePageTitle';

/** Friendly fallback for any route that fails to load or render. Never shows stack traces. */
export function RouteError() {
  const error = useRouteError();
  usePageTitle('Something went wrong');
  const status = isRouteErrorResponse(error) ? ` (${error.status})` : '';
  return (
    <div className="mx-auto flex max-w-prose flex-col gap-4 px-4 py-10">
      <Alert variant="destructive">
        <AlertTitle>Something went wrong{status}</AlertTitle>
        <AlertDescription>The page could not be shown. Try again, or go back to the overview.</AlertDescription>
      </Alert>
      <div className="flex gap-3">
        <Button onClick={() => window.location.reload()}>Reload</Button>
        <Button asChild variant="outline">
          <Link to="/">Overview</Link>
        </Button>
      </div>
    </div>
  );
}
