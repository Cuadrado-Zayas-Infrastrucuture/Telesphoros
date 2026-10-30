import { type ReactNode, useRef } from 'react';
import { useResultRender } from '@/hooks/useResultRender';

/**
 * Spec 019 D02b: the recommendation-summary region of one result row, the part `render-v1` measures (plan P2: a defined summary region, never a long
 * evidence panel a small screen could never half-show). It is focusable, so a keyboard or screen-reader user who reaches it is measured by the `focus`
 * path. The clinical result view is a separate build and adopts it; the test page fills it with synthetic ids only.
 */
export function RecommendationSummaryRegion({ resultId, patientId, children }: { resultId: string; patientId?: string; children: ReactNode }) {
  const region = useRef<HTMLDivElement>(null);
  useResultRender(resultId, region, patientId);
  return (
    <div
      ref={region}
      role="region"
      aria-label={`Recommendation summary, result ${resultId}`}
      tabIndex={0}
      data-render-region={resultId}
      className="flex flex-col gap-2 rounded-md border border-divider p-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      {children}
    </div>
  );
}
