import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { FunnelChart } from './FunnelChart';

const paths = (container: HTMLElement, part: 'halo' | 'core') => [...container.querySelectorAll<SVGPathElement>(`path[data-part="${part}"]`)];
// Half-height of a segment's left edge, read back from the drawn path: "M 0 <top> …".
const leftHalfHeight = (path: SVGPathElement, height: number) => height / 2 - Number(/^M 0 (-?[\d.]+)/.exec(path.getAttribute('d') ?? '')?.[1]);

describe('FunnelChart', () => {
  const stages = [
    { label: 'Registered', value: 10 },
    { label: 'File uploaded', value: 8 },
    { label: 'Read', value: 4 },
  ];

  it('is decorative and draws one halo and one core per stage', () => {
    const { container } = render(<FunnelChart stages={stages} />);
    const svg = container.querySelector('svg') as SVGSVGElement;
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(paths(container, 'halo')).toHaveLength(3);
    expect(paths(container, 'core')).toHaveLength(3);
  });

  it('narrows in proportion to each stage, the halo around the core', () => {
    const { container } = render(<FunnelChart stages={stages} height={100} />);
    const cores = paths(container, 'core').map((path) => leftHalfHeight(path, 100));
    const halos = paths(container, 'halo').map((path) => leftHalfHeight(path, 100));
    expect(cores[1] / cores[0]).toBeCloseTo(0.8, 5);
    expect(cores[2] / cores[0]).toBeCloseTo(0.4, 5);
    halos.forEach((halo, index) => expect(halo).toBeGreaterThan(cores[index]));
  });

  it('never widens: a later stage larger than an earlier one is drawn no wider', () => {
    const { container } = render(
      <FunnelChart
        stages={[
          { label: 'A', value: 4 },
          { label: 'B', value: 9 },
        ]}
        height={100}
      />,
    );
    const [first, second] = paths(container, 'core').map((path) => leftHalfHeight(path, 100));
    expect(second).toBeLessThanOrEqual(first);
  });

  it('draws an empty funnel without NaN when there is nothing to count', () => {
    const { container } = render(
      <FunnelChart
        stages={[
          { label: 'A', value: 0 },
          { label: 'B', value: 0 },
        ]}
      />,
    );
    for (const path of container.querySelectorAll('path')) expect(path.getAttribute('d')).not.toMatch(/NaN|Infinity/);
  });

  it('draws nothing for no stages', () => {
    expect(render(<FunnelChart stages={[]} />).container.querySelector('svg')).toBeNull();
  });
});
