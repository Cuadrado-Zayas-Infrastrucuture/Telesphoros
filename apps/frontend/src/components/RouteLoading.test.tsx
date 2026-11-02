import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RouteLoading } from './RouteLoading';

describe('the initial route loading state', () => {
  it('reserves content space with decorative placeholders and one loading announcement', () => {
    const { container } = render(<RouteLoading />);
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status')).toHaveTextContent('Loading…');
    const placeholders = container.querySelectorAll('[data-slot="skeleton"]');
    expect(placeholders.length).toBeGreaterThan(3);
    for (const placeholder of placeholders) expect(placeholder).toHaveAttribute('aria-hidden', 'true');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
