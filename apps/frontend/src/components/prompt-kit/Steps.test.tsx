import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { Steps } from './Steps';

const LABELS = ['Check the file', 'Send it', 'List it'] as const;
const WORDS = { done: 'Done', failed: 'Failed', active: 'In progress', waiting: 'Waiting' };
/** Whether each step's mark carries the signal colour, in order. */
const signalMarks = () => screen.getAllByRole('listitem').map((item) => item.querySelector('span[aria-hidden="true"]')!.classList.contains('text-signal'));

it('marks only the step under way in the signal colour, and leaves its word plain (specs/043 D4)', () => {
  render(<Steps colored stage={1} labels={LABELS} words={WORDS} label="Upload steps" />);
  expect(signalMarks()).toEqual([false, true, false]);
  expect(screen.getByText('In progress')).not.toHaveClass('text-signal');
  expect(screen.getByText('In progress')).toHaveClass('text-muted-foreground');
});

it('gives a failed step no signal mark: failure keeps its own word and colour', () => {
  render(<Steps colored failed stage={1} labels={LABELS} words={WORDS} label="Upload steps" />);
  expect(signalMarks()).toEqual([false, false, false]);
  expect(screen.getByText('Failed')).toHaveClass('text-destructive');
});

it('marks nothing once every step is done', () => {
  render(<Steps colored stage={3} labels={LABELS} words={WORDS} label="Upload steps" />);
  expect(signalMarks()).toEqual([false, false, false]);
});

it('marks the step under way in the plain list, the chat preview, too, and keeps every word plain', () => {
  render(<Steps stage={1} labels={LABELS} words={WORDS} label="Preview steps" />);
  expect(signalMarks()).toEqual([false, true, false]);
  expect(screen.getByText('Done')).toHaveClass('text-muted-foreground');
  expect(screen.getByText('In progress')).toHaveClass('text-muted-foreground');
});
