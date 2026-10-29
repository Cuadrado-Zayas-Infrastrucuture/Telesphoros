// Composed after the shadcn/ui Skeleton "Card" example (https://ui.shadcn.com/docs/components/base/skeleton, MIT).
import { Card } from './Card';
import { CardContent } from './CardContent';
import { CardHeader } from './CardHeader';
import { Skeleton } from './Skeleton';
import { SkeletonText } from './SkeletonText';

/**
 * A real Card holding placeholders shaped like a titled card of label/value rows (SettingsSection with SettingsRow), so the page keeps its
 * layout when the content arrives.
 */
export function SkeletonCard({ rows = 3, description = false }: { rows?: number; description?: boolean }) {
  return (
    <Card aria-hidden="true">
      <CardHeader>
        <Skeleton className="h-5 w-40" />
        {description && <SkeletonText lines={1} className="mt-1" />}
      </CardHeader>
      <CardContent>
        {Array.from({ length: rows }, (_, index) => (
          <div key={index} className="flex flex-col gap-2 border-b border-divider px-2 py-3 last:border-b-0 sm:flex-row sm:items-center sm:gap-6">
            <Skeleton className="h-3.5 w-28 sm:w-40 sm:shrink-0" />
            <Skeleton className="h-4 w-16" />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
