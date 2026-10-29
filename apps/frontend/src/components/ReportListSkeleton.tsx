import { SkeletonTableRows } from '@/components/ui/SkeletonTableRows';

/** Decorative rows reserve the report layout; the pager announces loading once. */
export function ReportListSkeleton({ showPatient = true }: { showPatient?: boolean }) {
  return <SkeletonTableRows columns={[showPatient ? ['w-3/4', 'w-1/2'] : ['w-3/4'], ['w-3/4'], ['w-full']]} />;
}
