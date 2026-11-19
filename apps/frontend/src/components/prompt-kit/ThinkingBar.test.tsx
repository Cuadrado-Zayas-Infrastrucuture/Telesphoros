import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { ThinkingBar } from './ThinkingBar';

it('fills the phases reached and the turning ring in the signal colour, and leaves the rest plain (specs/043 D4)', () => {
  const { container } = render(<ThinkingBar text="Preparing a sample" stage={1} onStop={() => undefined} />);
  const phases = [...container.querySelectorAll('span.h-1')];
  expect(phases.map((phase) => phase.classList.contains('bg-signal'))).toEqual([true, true, false]);
  expect(container.querySelectorAll('.border-signal')).toHaveLength(1);
  expect(screen.getByRole('button', { name: 'Stop preview' }).className).not.toMatch(/signal/);
});
