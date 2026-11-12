import type { StructuredRecordState } from '@telesphoros/shared-types';

type Source = StructuredRecordState['history'][number];

/**
 * The conflicting sources side by side, one column each (specs/038 D16), from what the saved history carries: the laboratory's report id,
 * the revision and its status, when it was saved, and which findings each holds. It chooses nothing and marks nothing as preferred. What
 * each source reports for a finding is not in the history the API sends, and the table says so instead of leaving it to be assumed equal.
 */
export function SourceComparison({ sources, thisReportId }: { sources: readonly Source[]; thisReportId: string }) {
  if (sources.length < 2) return null;
  const shared = sources[0]!.findingIds.filter((id) => sources.every((source) => source.findingIds.includes(id)));
  const row = 'border-t border-divider px-2 py-2 text-left align-top font-normal';
  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="pb-1 text-left font-semibold">Conflicting sources, side by side</caption>
          <thead>
            <tr>
              <td className="px-2 py-2" />
              {sources.map((source) => (
                <th key={source.id} scope="col" className="px-2 py-2 text-left align-top font-semibold break-words">
                  {source.laboratoryReportId}
                  {/* Two sources can carry the same laboratory report id (that is one way they conflict), so each column also says which upload it is. */}
                  <span className="block font-normal text-muted-foreground">{source.reportId === thisReportId ? 'This upload' : 'Another upload'}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row" className={`${row} text-muted-foreground`}>
                Revision
              </th>
              {sources.map((source) => (
                <td key={source.id} className={row}>
                  {source.revision} ({source.status})
                </td>
              ))}
            </tr>
            <tr>
              <th scope="row" className={`${row} text-muted-foreground`}>
                Saved
              </th>
              {sources.map((source) => (
                <td key={source.id} className={row}>
                  {new Date(source.createdAt).toLocaleString()}
                </td>
              ))}
            </tr>
            <tr>
              <th scope="row" className={`${row} text-muted-foreground`}>
                Findings saved
              </th>
              {sources.map((source) => (
                <td key={source.id} className={row}>
                  {source.findingIds.length}
                </td>
              ))}
            </tr>
            <tr>
              <th scope="row" className={`${row} text-muted-foreground`}>
                Findings only this source has
              </th>
              {sources.map((source) => {
                const own = source.findingIds.filter((id) => !shared.includes(id));
                return (
                  <td key={source.id} className={`${row} break-words`}>
                    {own.length > 0 ? own.join(', ') : 'None'}
                  </td>
                );
              })}
            </tr>
          </tbody>
        </table>
      </div>
      <p className="text-muted-foreground">
        {shared.length} {shared.length === 1 ? 'finding is' : 'findings are'} in every source. What each source reports for a finding (the result, its interpretation, the assay’s
        limits) is not sent with this list, so it cannot be compared here. Read each report before choosing.
      </p>
    </div>
  );
}
