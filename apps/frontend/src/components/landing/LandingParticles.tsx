import type { CSSProperties } from 'react';

export type ParticlePlacement = 'hero' | 'closing';
export type Particle = { x: number; y: number; size: 'sm' | 'md' | 'lg'; tone: 'accent' | 'soft' | 'deep'; depth: number; delay: number };
type Area = { left: number; width: number; top: number; height: number };

const fraction = (value: number) => value - Math.floor(value);
const round = (value: number) => Math.round(value * 10) / 10;

/**
 * Fixed positions from a low-discrepancy (R2) sequence: the same on every render, so layout and screenshots are
 * stable and nothing depends on randomness. Each area stays on the right-hand side of its section, clear of the
 * points where the text sits, so the dots never change the contrast measured for any text.
 */
function layout(count: number, area: Area, tones: Particle['tone'][]): Particle[] {
  return Array.from({ length: count }, (_, index) => ({
    x: round(area.left + area.width * fraction(0.5 + index * 0.7548776662)),
    y: round(area.top + area.height * fraction(0.5 + index * 0.5698402910)),
    size: index % 5 === 0 ? 'lg' : index % 3 === 0 ? 'md' : 'sm',
    tone: tones[index % tones.length],
    depth: round(0.4 + 0.6 * fraction(index * 0.6180339887)),
    delay: Math.round((0.15 + 0.6 * fraction(index * 0.4142135624)) * 100) / 100,
  }));
}

export const landingParticles: Record<ParticlePlacement, Particle[]> = {
  hero: layout(32, { left: 64, width: 34, top: 4, height: 80 }, ['accent', 'accent', 'soft']),
  closing: layout(14, { left: 72, width: 26, top: 8, height: 80 }, ['accent', 'deep']),
};

/**
 * A code-drawn particle field that echoes the approved particle DNA without touching it. Decorative only:
 * hidden from assistive technology, never interactive, and still (not hidden) under reduced motion.
 */
export function LandingParticles({ placement }: { placement: ParticlePlacement }) {
  return <div className={`landing-particles landing-particles--${placement}`} aria-hidden="true">
    {landingParticles[placement].map(particle => <span
      key={`${particle.x}-${particle.y}`}
      className={`landing-particle landing-particle--${particle.size} landing-particle--${particle.tone}`}
      style={{ '--particle-x': `${particle.x}%`, '--particle-y': `${particle.y}%`, '--particle-depth': particle.depth, '--particle-delay': `${particle.delay}s` } as CSSProperties}
    ><span /></span>)}
  </div>;
}
