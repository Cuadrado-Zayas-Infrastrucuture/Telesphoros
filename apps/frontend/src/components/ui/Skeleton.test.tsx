import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { Skeleton } from './Skeleton';
import { SkeletonCard } from './SkeletonCard';
import { SkeletonText } from './SkeletonText';
import { ReportListSkeleton } from '@/components/ReportListSkeleton';

describe('Skeleton', () => {
  it('is a decorative placeholder drawn by the shared .skeleton rule', () => {
    const { container } = render(<Skeleton className="h-4 w-3/4" />);
    const block = container.firstElementChild as HTMLElement;
    expect(block.getAttribute('aria-hidden')).toBe('true');
    expect(block.dataset.slot).toBe('skeleton');
    for (const name of ['skeleton', 'rounded-sm', 'h-4', 'w-3/4']) expect(block.classList).toContain(name);
    expect(block.classList).not.toContain('animate-pulse');
  });

  it('waits before appearing, sweeps slowly, and drops the sweep under reduced motion (styles/index.css)', () => {
    const css = readFileSync(resolve(__dirname, '../../styles/index.css'), 'utf8');
    const rule = css.slice(css.indexOf('  .skeleton {'), css.indexOf('@keyframes skeleton-appear'));
    expect(rule).toMatch(/opacity: 0;/);
    expect(rule).toMatch(/skeleton-appear 0s linear var\(--delay-skeleton\) forwards/);
    expect(rule).toMatch(/skeleton-shimmer var\(--duration-skeleton-shimmer\)/);
    const reduced = rule.slice(rule.indexOf('prefers-reduced-motion'));
    expect(reduced).toMatch(/background-image: none;/);
    expect(reduced).not.toMatch(/skeleton-shimmer/);
    expect(rule).toMatch(/forced-colors: active/);
  });

  it('keeps the report list placeholder at five hidden rows, with or without the patient line', () => {
    for (const [showPatient, perRow] of [
      [true, 4],
      [false, 3],
    ] as const) {
      const { container, unmount } = render(
        <table>
          <ReportListSkeleton showPatient={showPatient} />
        </table>,
      );
      const body = container.querySelector('tbody') as HTMLElement;
      expect(body.getAttribute('aria-hidden')).toBe('true');
      expect(body.querySelectorAll('tr')).toHaveLength(5);
      expect(body.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(5 * perRow);
      unmount();
    }
  });

  it('draws text lines with a short last line, and a card of label/value rows, all hidden from assistive technology', () => {
    const text = render(<SkeletonText lines={3} />).container.firstElementChild as HTMLElement;
    expect(text.getAttribute('aria-hidden')).toBe('true');
    const lines = text.querySelectorAll('[data-slot="skeleton"]');
    expect(lines).toHaveLength(3);
    expect(lines[2]!.classList).toContain('w-2/3');
    const card = render(<SkeletonCard rows={2} description />).container.firstElementChild as HTMLElement;
    expect(card.getAttribute('aria-hidden')).toBe('true');
    // Title, one description line, and a label and value per row.
    expect(card.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(1 + 1 + 2 * 2);
  });
});
