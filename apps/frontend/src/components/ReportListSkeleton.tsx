/** Decorative rows reserve the report layout; the pager announces loading once. */
export function ReportListSkeleton() {
  return <tbody aria-hidden="true" className="motion-safe:animate-pulse">
    {Array.from({ length: 5 }, (_, index) => <tr key={index} className="border-b border-divider">
      <td className="px-3 py-3"><div className="h-4 w-3/4 rounded-sm bg-divider" /><div className="mt-3 h-3 w-1/2 rounded-sm bg-divider" /></td>
      <td className="px-3 py-3"><div className="h-4 w-3/4 rounded-sm bg-divider" /></td>
      <td className="px-3 py-3"><div className="h-4 w-full rounded-sm bg-divider" /></td>
    </tr>)}
  </tbody>;
}
