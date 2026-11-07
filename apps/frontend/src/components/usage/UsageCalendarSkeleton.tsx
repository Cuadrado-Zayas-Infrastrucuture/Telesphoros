// Composed after the shadcn/ui Skeleton table pattern (https://ui.shadcn.com/docs/components/base/skeleton, MIT), with the month table's two columns.
import { Skeleton } from '@/components/ui/Skeleton';

/** The calendar while it loads: the summary line, the grid's block, then the month table's header and rows. The loader's status text announces it. */
export function UsageCalendarSkeleton() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-4">
      <Skeleton className="h-5 w-72 max-w-full" />
      <Skeleton className="h-32 w-full" />
      <div className="flex flex-col gap-4">
        <div className="flex gap-4 border-b border-divider pb-2">
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-4 w-24" />
        </div>
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="flex gap-4">
            <Skeleton className="h-4 flex-1" />
            <Skeleton className="h-4 w-24" />
          </div>
        ))}
      </div>
    </div>
  );
}
