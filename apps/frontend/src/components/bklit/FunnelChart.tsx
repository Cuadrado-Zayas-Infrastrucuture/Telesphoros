// Adapted from Bklit UI FunnelChart; see README.md and LICENSE.md.
import { cn } from '@/lib/utils';

export interface FunnelStage {
  label: string;
  value: number;
}

export interface FunnelChartProps {
  /** Stages in order; the first is the widest. */
  stages: readonly FunnelStage[];
  /** viewBox size; the SVG scales to its box. */
  width?: number;
  height?: number;
  /** Gap between segments in viewBox units. */
  gap?: number;
  className?: string;
}

// Upstream's ring formula with two layers: the halo at full scale, the core inside it.
const HALO_SCALE = 1;
const CORE_SCALE = 1 - (1 / 2) * 0.35;

/** Upstream hSegmentPath (curved): a trapezoid-like segment easing from one stage's height to the next. */
function segmentPath(normStart: number, normEnd: number, segW: number, H: number, layerScale: number) {
  const my = H / 2;
  const h0 = normStart * H * 0.44 * layerScale;
  const h1 = normEnd * H * 0.44 * layerScale;
  const cx = segW * 0.55;
  const top = `M 0 ${my - h0} C ${cx} ${my - h0}, ${segW - cx} ${my - h1}, ${segW} ${my - h1}`;
  const bot = `L ${segW} ${my + h1} C ${segW - cx} ${my + h1}, ${cx} ${my + h0}, 0 ${my + h0}`;
  return `${top} ${bot} Z`;
}

/** Decorative funnel. Give the counts as text beside it: the drawing is hidden from assistive technology. */
export function FunnelChart({ stages, width = 600, height = 120, gap = 4, className }: FunnelChartProps) {
  if (!stages.length) return null;
  const max = Math.max(stages[0].value, 0);
  // A funnel never widens: a later stage is drawn no wider than the one before it.
  const norms = stages.reduce<number[]>((acc, stage, index) => {
    const raw = max > 0 ? Math.max(stage.value, 0) / max : 0;
    return [...acc, index === 0 ? raw : Math.min(raw, acc[index - 1])];
  }, []);
  const n = stages.length;
  const segW = (width - gap * (n - 1)) / n;
  return (
    <svg aria-hidden="true" focusable="false" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className={cn('block w-full', className)}>
      {stages.map((stage, index) => {
        const start = norms[index];
        const end = norms[Math.min(index + 1, n - 1)];
        return (
          <g key={stage.label} transform={`translate(${index * (segW + gap)} 0)`}>
            <path data-part="halo" fill="var(--brand-accent)" fillOpacity={0.18} d={segmentPath(start, end, segW, height, HALO_SCALE)} />
            <path data-part="core" fill="var(--primary)" d={segmentPath(start, end, segW, height, CORE_SCALE)} />
            {/* A segment that starts empty has nothing to draw; a hairline says "none" instead of leaving a gap. */}
            {start === 0 && (
              <line data-part="baseline" x1={0} x2={segW} y1={height / 2} y2={height / 2} stroke="var(--divider)" strokeWidth={2} vectorEffect="non-scaling-stroke" />
            )}
          </g>
        );
      })}
    </svg>
  );
}
