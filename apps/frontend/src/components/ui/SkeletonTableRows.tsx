// Composed after the shadcn/ui Skeleton "Table" example (https://ui.shadcn.com/docs/components/base/skeleton, MIT).
import { cn } from '@/lib/utils';
import { Skeleton } from './Skeleton';

/**
 * Placeholder rows for a table body. `columns` gives each cell's bar widths: one width is a single line, two widths stack a second, shorter
 * line (a name over its detail). Decorative; the table's own status text announces loading.
 */
export function SkeletonTableRows({ columns, rows = 5 }: { columns: ReadonlyArray<readonly [string, string?]>; rows?: number }) {
  return (
    <tbody aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        <tr key={index} className="border-b border-divider">
          {columns.map(([first, second], cell) => (
            <td key={cell} className="px-3 py-3">
              <Skeleton className={cn('h-4', first)} />
              {second && <Skeleton className={cn('mt-3 h-3', second)} />}
            </td>
          ))}
        </tr>
      ))}
    </tbody>
  );
}
