// Adapted from Motion Primitives ProgressiveBlur; see README.md and LICENSE.md.
// The only place the app may blur (specs/005-progressive-blur-edge): a decorative scroll edge.
import type { CSSProperties } from 'react';
import { cn } from '@/lib/utils';

const GRADIENT_ANGLES = { top: 0, right: 90, bottom: 180, left: 270 } as const;
const MAX_LAYERS = 8;
// 0.5px a layer keeps the deepest layer at 3.5px: content passing the edge stays legible.
const MAX_INTENSITY = 0.5;

export interface ProgressiveBlurProps {
  /** The scroll edge the blur sits on; it strengthens toward that edge. */
  edge?: keyof typeof GRADIENT_ANGLES;
  /** Number of blur layers, 2 to 8. */
  layers?: number;
  /** Blur added per layer in px, at most 0.5. */
  intensity?: number;
  className?: string;
}

/** Decorative edge for a scroll container whose content is padded by --size-blur-edge on that side. */
export function ProgressiveBlur({ edge = 'bottom', layers = MAX_LAYERS, intensity = 0.25, className }: ProgressiveBlurProps) {
  const count = Math.min(Math.max(Math.round(layers), 2), MAX_LAYERS);
  const step = Math.min(Math.max(intensity, 0), MAX_INTENSITY);
  const segment = 1 / (count + 1);
  return (
    <div aria-hidden="true" data-edge={edge} className={cn('progressive-blur', className)}>
      {Array.from({ length: count }, (_, index) => {
        // A mask reads alpha only, so any opaque token draws the band.
        const stops = [0, 1, 2, 3].map((offset) => `${offset === 1 || offset === 2 ? 'var(--foreground)' : 'transparent'} ${(index + offset) * segment * 100}%`);
        const style = {
          '--progressive-blur-mask': `linear-gradient(${GRADIENT_ANGLES[edge]}deg, ${stops.join(', ')})`,
          '--progressive-blur-radius': `${index * step}px`,
        } as CSSProperties;
        return <div key={index} className="progressive-blur-layer" style={style} />;
      })}
    </div>
  );
}
