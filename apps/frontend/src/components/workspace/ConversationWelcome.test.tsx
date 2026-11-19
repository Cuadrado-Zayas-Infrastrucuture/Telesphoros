import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { ConversationWelcome } from './ConversationWelcome';

it('carries one signal-colour mark, as decoration under the heading (specs/043 D3)', () => {
  const { container } = render(<ConversationWelcome preferredName={null} canAttach={false} />);
  const marks = container.querySelectorAll('.one-screen-signal-rule');
  expect(marks).toHaveLength(1);
  const mark = marks[0]!;
  expect(mark).toHaveAttribute('aria-hidden', 'true');
  expect(mark).toBeEmptyDOMElement();
  expect(mark.previousElementSibling).toBe(screen.getByRole('heading', { level: 1, name: 'Start with a synthetic report.' }));
});

it('keeps the words that say a typed question is not answered', () => {
  render(<ConversationWelcome preferredName={null} canAttach={false} />);
  expect(screen.getByText('Typed questions are not answered or saved.')).toBeInTheDocument();
});
