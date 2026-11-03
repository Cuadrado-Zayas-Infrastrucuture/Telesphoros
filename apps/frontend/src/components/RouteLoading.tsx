import { ContentSkeleton } from '@/components/ui/ContentSkeleton';

/** Layout reserved while the initial route's code is fetched. */
export function RouteLoading() {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-page flex-col px-4 py-6 sm:px-6 sm:py-10">
      <ContentSkeleton label="Loading…" variant="page" />
    </div>
  );
}
