import { Skeleton } from '@/components/ui/Skeleton';

/** Decorative rows reserve the report layout; the pager announces loading once. */
export function ReportListSkeleton({ showPatient = true }: { showPatient?: boolean }) {
  return (
    <tbody aria-hidden="true">
      {Array.from({ length: 5 }, (_, index) => (
        <tr key={index} className="border-b border-divider">
          <td className="px-3 py-3">
            <Skeleton className="h-4 w-3/4" />
            {showPatient && <Skeleton className="mt-3 h-3 w-1/2" />}
          </td>
          <td className="px-3 py-3">
            <Skeleton className="h-4 w-3/4" />
          </td>
          <td className="px-3 py-3">
            <Skeleton className="h-4 w-full" />
          </td>
        </tr>
      ))}
    </tbody>
  );
}
