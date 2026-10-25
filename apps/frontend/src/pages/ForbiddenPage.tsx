import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { usePageTitle } from '@/hooks/usePageTitle';

export default function ForbiddenPage() {
  usePageTitle('No access');
  return (
    <div className="flex max-w-prose flex-col gap-4">
      <h1 className="text-3xl leading-tight font-bold">You do not have access to this page</h1>
      <p className="text-muted-foreground">Your account does not have the role this page needs. If you think it should, ask your administrator.</p>
      <div>
        <Button asChild variant="outline">
          <Link to="/">Back to overview</Link>
        </Button>
      </div>
    </div>
  );
}
