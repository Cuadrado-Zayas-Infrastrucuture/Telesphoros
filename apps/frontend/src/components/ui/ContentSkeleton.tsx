import { Skeleton } from './Skeleton';

/** Shared read-loading layouts. Placeholders contain no invented patient or result data. */
export function ContentSkeleton({ label, variant = 'list' }: { label: string; variant?: 'list' | 'detail' | 'compact' | 'page' }) {
  return (
    <div className="flex w-full min-w-0 flex-col gap-3" aria-busy="true">
      {label && (
        <p role="status" className="sr-only">
          {label}
        </p>
      )}
      <div aria-hidden="true" className="flex min-w-0 flex-col gap-3">
        {(variant === 'page' || variant === 'detail') && <Skeleton className="h-8 w-48 max-w-full" />}
        {Array.from({ length: variant === 'compact' ? 2 : 3 }, (_, index) => (
          <div key={index} className={variant === 'compact' ? 'flex flex-col gap-2 py-1' : 'flex flex-col gap-3 rounded-lg border border-divider p-4'}>
            <Skeleton className="h-4 w-2/3" />
            {variant !== 'compact' && <Skeleton className="h-4 w-1/2" />}
            {(variant === 'page' || variant === 'detail') && <Skeleton className="h-10 w-full" />}
          </div>
        ))}
      </div>
    </div>
  );
}
