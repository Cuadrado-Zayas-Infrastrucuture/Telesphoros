import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { LandingParticles, landingParticles } from './LandingParticles';

describe('LandingParticles', () => {
  it('uses the same fixed, distinct positions on every render', () => {
    const first = render(<LandingParticles placement="hero" />).container.innerHTML;
    const second = render(<LandingParticles placement="hero" />).container.innerHTML;
    expect(first).toBe(second);
    for (const particles of Object.values(landingParticles)) {
      expect(new Set(particles.map((particle) => `${particle.x}-${particle.y}`)).size).toBe(particles.length);
    }
  });

  // Text sits in the left part of each section (its centre at or under 52% of the width at every tested size),
  // so dots kept to the right never change the background measured for any text.
  it.each([
    ['hero', 64, 98, 4, 84],
    ['closing', 72, 98, 8, 88],
  ] as const)('keeps %s dots inside their area, clear of the text', (placement, left, right, top, bottom) => {
    for (const particle of landingParticles[placement]) {
      expect(particle.x).toBeGreaterThanOrEqual(left);
      expect(particle.x).toBeLessThanOrEqual(right);
      expect(particle.y).toBeGreaterThanOrEqual(top);
      expect(particle.y).toBeLessThanOrEqual(bottom);
      expect(particle.depth).toBeGreaterThan(0);
      expect(particle.delay).toBeGreaterThan(0);
    }
  });

  it('is decoration only', () => {
    const { container } = render(<LandingParticles placement="closing" />);
    const field = container.firstElementChild!;
    expect(field).toHaveAttribute('aria-hidden', 'true');
    expect(field.querySelectorAll('.landing-particle')).toHaveLength(landingParticles.closing.length);
    expect(field.querySelector('a, button, input, [tabindex]')).toBeNull();
  });
});
