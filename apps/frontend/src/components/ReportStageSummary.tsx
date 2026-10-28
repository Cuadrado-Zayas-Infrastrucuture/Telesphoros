import { FunnelChart } from '@/components/bklit/FunnelChart';
import { ReportStageNote } from '@/components/ReportStageNote';
import { formatCount, formatShare, type ReportStageCounts } from '@/lib/reportStages';

/** The counted stages: funnel, aligned label/value pairs and the Read note. */
export function ReportStageSummary({ counts }: { counts: ReportStageCounts }) {
  if (counts.registered === 0) return <p className="text-sm text-muted-foreground">No reports to count yet.</p>;
  const stages = [
    { label: 'Registered', value: counts.registered },
    { label: 'File uploaded', value: counts.uploaded },
    { label: 'Read', value: counts.read },
  ];
  return (
    <>
      <FunnelChart stages={stages} className="h-16" />
      {/* Three equal columns under the funnel segments; labels share one row and values the next, so a wrapped label never pushes its value out of line. */}
      <dl className="grid w-full grid-cols-3 gap-x-2 text-sm">
        {stages.map((stage) => (
          <div key={stage.label} className="contents">
            <dt className="row-start-1 min-w-0 self-end text-muted-foreground">{stage.label}</dt>
            <dd className="row-start-2 min-w-0 font-semibold">
              {formatCount(stage.value)} <span className="font-normal text-muted-foreground">{formatShare(stage.value, counts.registered)}</span>
            </dd>
          </div>
        ))}
      </dl>
      <ReportStageNote cap={counts.capped ? ` Counted from the first ${formatCount(counts.registered)} of ${formatCount(counts.total)} reports.` : undefined} />
    </>
  );
}
