// Composed after the shadcn/ui Skeleton "Text" example (https://ui.shadcn.com/docs/components/base/skeleton, MIT).
import { cn } from '@/lib/utils';
import { Skeleton } from './Skeleton';

const WIDTHS = ['w-full', 'w-11/12', 'w-4/5', 'w-5/6'];

/** Lines of placeholder text: the last (or only) line shortest, like a real paragraph's ragged edge. */
export function SkeletonText({ lines = 2, className }: { lines?: number; className?: string }) {
  return (
    <div aria-hidden="true" className={cn('flex flex-col gap-2', className)}>
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton key={index} className={cn('h-3.5', index === lines - 1 ? 'w-2/3' : WIDTHS[index % WIDTHS.length])} />
      ))}
    </div>
  );
}
