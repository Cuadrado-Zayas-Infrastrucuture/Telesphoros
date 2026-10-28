import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { Skeleton } from './Skeleton';
import { ReportListSkeleton } from '@/components/ReportListSkeleton';

describe('Skeleton', () => {
  it('is a decorative placeholder in the approved divider tone, pulsing only when motion is allowed', () => {
    const { container } = render(<Skeleton className="h-4 w-3/4" />);
    const block = container.firstElementChild as HTMLElement;
    expect(block.getAttribute('aria-hidden')).toBe('true');
    expect(block.dataset.slot).toBe('skeleton');
    for (const name of ['bg-divider', 'rounded-sm', 'motion-safe:animate-pulse', 'h-4', 'w-3/4']) expect(block.classList).toContain(name);
    expect(block.classList).not.toContain('animate-pulse');
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
});
