import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { ProgressiveBlur } from './ProgressiveBlur';

const layersOf = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('.progressive-blur-layer')];
const radiusOf = (layer: HTMLElement) => Number.parseFloat(layer.style.getPropertyValue('--progressive-blur-radius'));

describe('ProgressiveBlur', () => {
  it('is decorative: hidden from assistive technology and placed on the edge it names', () => {
    const { container } = render(<ProgressiveBlur edge="top" />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.getAttribute('aria-hidden')).toBe('true');
    expect(root.dataset.edge).toBe('top');
    expect(root.classList.contains('progressive-blur')).toBe(true);
  });

  it('defaults to eight layers that strengthen toward the edge, the deepest 1.75px', () => {
    const radii = layersOf(render(<ProgressiveBlur />).container).map(radiusOf);
    expect(radii).toEqual([0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75]);
  });

  it('keeps between two and eight layers whatever it is given', () => {
    expect(layersOf(render(<ProgressiveBlur layers={40} />).container)).toHaveLength(8);
    expect(layersOf(render(<ProgressiveBlur layers={0} />).container)).toHaveLength(2);
  });

  it('never blurs a layer more than 3.5px, however strong the request', () => {
    const radii = layersOf(render(<ProgressiveBlur layers={8} intensity={10} />).container).map(radiusOf);
    expect(Math.max(...radii)).toBe(3.5);
    expect(radii.every((radius) => radius >= 0)).toBe(true);
  });

  it('masks each layer with an alpha band rather than a colour of its own', () => {
    for (const layer of layersOf(render(<ProgressiveBlur edge="bottom" />).container)) {
      const mask = layer.style.getPropertyValue('--progressive-blur-mask');
      expect(mask).toMatch(/^linear-gradient\(180deg, /);
      expect(mask).not.toMatch(/#|rgb/);
    }
  });
});
