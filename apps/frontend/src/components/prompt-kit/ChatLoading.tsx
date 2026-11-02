import { Skeleton } from '@/components/ui/Skeleton';

/** A pending chat operation, never a fabricated answer or progress estimate. */
export function ChatLoading({ label }: { label?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-3 py-3">
      {label && (
        <p role="status" className="text-sm text-muted-foreground">
          {label}
        </p>
      )}
      <div aria-hidden="true" className="flex flex-col gap-3">
        <Skeleton className="h-3 w-3/4" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-1/2" />
      </div>
    </div>
  );
}
