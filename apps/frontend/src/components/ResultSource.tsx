import { citationView } from '@/lib/citationView';

const NOT_RECORDED = 'not recorded';

/**
 * Where a result's wording comes from, as it was stored with the result (specs/038 D5): the guideline and its version, the place in it, and
 * the verification state. A part the stored citation does not carry reads "not recorded"; nothing is taken from the knowledge loaded now.
 */
export function ResultSource({ citation, strength }: { citation: unknown; strength: string | null }) {
  const view = citationView(citation);
  if (!view) return null;
  const location = (['table', 'row', 'column'] as const).flatMap((part) => (view.location?.[part] ? [`${part} ${view.location[part]}`] : []));
  return (
    <dl aria-label="Source" className="flex flex-col gap-1 text-sm">
      <div className="flex flex-wrap gap-x-2">
        <dt className="text-muted-foreground">Guideline</dt>
        <dd className="wrap-anywhere">
          {view.guideline ?? NOT_RECORDED} · version {view.version ?? NOT_RECORDED}
        </dd>
      </div>
      <div className="flex flex-wrap gap-x-2">
        <dt className="text-muted-foreground">Location</dt>
        <dd className="wrap-anywhere">{location.length > 0 ? location.join(', ') : NOT_RECORDED}</dd>
      </div>
      <div className="flex flex-wrap gap-x-2">
        <dt className="text-muted-foreground">Verification</dt>
        <dd className={view.verification?.caution ? 'text-warning' : undefined}>{view.verification?.word ?? NOT_RECORDED}</dd>
      </div>
      {strength && (
        <div className="flex flex-wrap gap-x-2">
          <dt className="text-muted-foreground">Strength, as the source states it</dt>
          <dd className="wrap-anywhere">{strength}</dd>
        </div>
      )}
      {view.sourceUrl && (
        <div className="flex flex-wrap gap-x-2">
          <dt className="text-muted-foreground">Published source</dt>
          <dd className="wrap-anywhere">
            <a className="inline-flex min-h-control items-center underline" href={view.sourceUrl} target="_blank" rel="noopener noreferrer">
              Open the source (new tab)
            </a>
          </dd>
        </div>
      )}
    </dl>
  );
}
