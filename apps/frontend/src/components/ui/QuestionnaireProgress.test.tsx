import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { QuestionnaireProgress } from './QuestionnaireProgress';

const STEPS = ['Choose', 'Check', 'Send'] as const;

it('underlines only the current step in the signal colour (specs/043 D4)', () => {
  render(<QuestionnaireProgress steps={STEPS} active={1} />);
  const items = screen.getAllByRole('listitem');
  expect(items.map((item) => item.classList.contains('border-signal'))).toEqual([false, true, false]);
  expect(items[1]).toHaveAttribute('aria-current', 'step');
  expect(screen.getByRole('progressbar', { name: 'Upload guide progress' })).toHaveAttribute('value', '2');
});
