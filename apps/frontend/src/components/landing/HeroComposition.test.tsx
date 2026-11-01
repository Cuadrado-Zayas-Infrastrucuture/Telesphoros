import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { HeroBackdrop } from './HeroBackdrop';
import { HeroReportCard } from './HeroReportCard';

describe('hero composition', () => {
  it('draws the report card as still decoration: hidden from assistive technology and nothing to operate', () => {
    const { container } = render(<HeroReportCard />);
    const card = container.querySelector('.landing-report-card')!;
    expect(card).toHaveAttribute('aria-hidden', 'true');
    expect(card.querySelectorAll('a, button, input, select, textarea, [tabindex]')).toHaveLength(0);
  });

  it('uses the same fictional records and status wording as the capability fragments', () => {
    const { container } = render(<HeroReportCard />);
    const text = container.textContent ?? '';
    for (const expected of [
      'Example patient',
      'SYN-001.json',
      'Server verified',
      'SYN-002.json',
      'Not complete',
      'SYN-003.json',
      'Received',
      'Synthetic data only. Not for clinical use.',
    ])
      expect(text).toContain(expected);
    // Staging takes structured JSON only (specs/024 D4), so the card shows no PDF.
    expect(text).not.toContain('.pdf');
    expect(container.querySelectorAll('.landing-report-verified')).toHaveLength(1);
  });

  it('draws the backdrop from classes only: hidden, no images, no inline colours or styles', () => {
    const { container } = render(<HeroBackdrop />);
    expect(container.querySelector('.landing-backdrop')).toHaveAttribute('aria-hidden', 'true');
    expect(container.querySelectorAll('img, image, [style], [fill]:not([fill^="url("]), [stroke], [stop-color]')).toHaveLength(0);
    expect(container.querySelectorAll('.landing-backdrop-sequence text')).toHaveLength(48);
  });
});
