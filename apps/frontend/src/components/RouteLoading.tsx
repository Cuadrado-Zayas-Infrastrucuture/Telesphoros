import { Spinner } from '@/components/ui/Spinner';

/**
 * Shown while the first page's JavaScript is fetched. Every route is lazy, so without it the router renders nothing until the chunk arrives.
 * It stands in for the whole layout, so it is a bare status line; AppLayout's own "Loading page…" covers navigations after that.
 */
export function RouteLoading() {
  return (
    <div role="status" className="flex min-h-dvh items-center justify-center gap-2 px-4 text-sm text-muted-foreground">
      <Spinner /> Loading…
    </div>
  );
}
