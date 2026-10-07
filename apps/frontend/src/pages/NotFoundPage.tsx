import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { usePageTitle } from '@/hooks/usePageTitle';

export default function NotFoundPage() {
  usePageTitle('Page not found');
  return (
    <div className="flex max-w-prose flex-col gap-4">
      <h1 className="text-3xl leading-tight font-bold">Page not found</h1>
      <p className="text-muted-foreground">That address doesn't match anything in this application.</p>
      <div>
        <Button asChild>
          <Link to="/">Back to overview</Link>
        </Button>
      </div>
    </div>
  );
}
